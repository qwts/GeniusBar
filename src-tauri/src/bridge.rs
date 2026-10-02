//! Relays the web view's requests to the Node bridge (`bridge/bridge.mjs`)
//! and back (#7). The bridge runs in the bundled Node sidecar with the
//! bundled agent-comms; this module only forwards allowed methods, matches
//! replies to requests by id, and restarts the bridge if it exits.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

/// The principal operations the web view may call; bridge.mjs holds the
/// same list and checks it again.
pub const METHODS: &[&str] = &["census", "send", "inbox", "ack", "launch", "launchStatus"];

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const RESTART_MIN: Duration = Duration::from_secs(1);
const RESTART_MAX: Duration = Duration::from_secs(30);
/// A bridge that stayed up this long restarts quickly after its next exit.
const HEALTHY_RUN: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

type Reply = Result<Value, BridgeError>;

#[derive(Default)]
pub struct Bridge {
    next_id: AtomicU64,
    stopping: AtomicBool,
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
}

impl Bridge {
    fn settle(&self, id: u64, reply: Reply) {
        if let Some(sender) = self.pending.lock().unwrap().remove(&id) {
            let _ = sender.send(reply);
        }
    }

    fn fail_all(&self, error: &BridgeError) {
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(error.clone()));
        }
    }
}

/// Parses one bridge reply line into its request id and outcome.
pub fn parse_reply(line: &[u8]) -> Option<(u64, Reply)> {
    let reply: Value = serde_json::from_slice(line).ok()?;
    let id = reply.get("id")?.as_u64()?;
    if reply.get("ok") == Some(&Value::Bool(true)) {
        return Some((id, Ok(reply.get("result").cloned().unwrap_or(Value::Null))));
    }
    let error = reply.get("error");
    let field = |name: &str| {
        error
            .and_then(|e| e.get(name))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let code = Some(field("code"))
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "bridge-error".into());
    Some((
        id,
        Err(BridgeError {
            code,
            message: field("message"),
        }),
    ))
}

fn spawn_bridge<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::async_runtime::Receiver<CommandEvent>, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let script = resources.join("bridge").join("bridge.mjs");
    let comms = resources.join("components").join("agent-comms");
    let (events, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        .args([script, comms])
        .spawn()
        .map_err(|e| e.to_string())?;
    *app.state::<Bridge>().child.lock().unwrap() = Some(child);
    Ok(events)
}

/// Stops the bridge for good when the app exits: no restart, and the child
/// is killed rather than left to notice its closed stdin.
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    let bridge = app.state::<Bridge>();
    bridge.stopping.store(true, Ordering::SeqCst);
    if let Some(child) = bridge.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    bridge.fail_all(&BridgeError::new("bridge-stopped", "the app is quitting"));
}

/// Starts the bridge and keeps it running for the life of the app.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = RESTART_MIN;
        loop {
            if app.state::<Bridge>().stopping.load(Ordering::SeqCst) {
                return;
            }
            let started = Instant::now();
            match spawn_bridge(&app) {
                Ok(mut events) => {
                    while let Some(event) = events.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                if let Some((id, reply)) = parse_reply(&line) {
                                    app.state::<Bridge>().settle(id, reply);
                                }
                            }
                            CommandEvent::Stderr(line) => {
                                eprintln!("bridge: {}", String::from_utf8_lossy(&line).trim_end());
                            }
                            CommandEvent::Terminated(_) => break,
                            _ => {}
                        }
                    }
                }
                Err(error) => eprintln!("bridge failed to start: {error}"),
            }
            let bridge = app.state::<Bridge>();
            bridge.child.lock().unwrap().take();
            bridge.fail_all(&BridgeError::new("bridge-restarting", "the bridge exited"));
            if started.elapsed() >= HEALTHY_RUN {
                backoff = RESTART_MIN;
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(RESTART_MAX);
        }
    });
}

/// The web view's single entry point: `invoke('bridge', { method, params })`.
#[tauri::command]
pub async fn bridge(
    state: State<'_, Bridge>,
    method: String,
    params: Option<Value>,
) -> Result<Value, BridgeError> {
    if !METHODS.contains(&method.as_str()) {
        return Err(BridgeError::new("bad-request", "unknown method"));
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, sender);
    let line = format!(
        "{}\n",
        json!({ "id": id, "method": method, "params": params.unwrap_or_else(|| json!({})) })
    );
    let written = match state.child.lock().unwrap().as_mut() {
        Some(child) => child.write(line.as_bytes()).is_ok(),
        None => false,
    };
    if !written {
        state.pending.lock().unwrap().remove(&id);
        return Err(BridgeError::new(
            "bridge-unavailable",
            "the bridge is not running",
        ));
    }
    match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => Err(BridgeError::new("bridge-restarting", "the bridge exited")),
        Err(_) => {
            state.pending.lock().unwrap().remove(&id);
            Err(BridgeError::new(
                "bridge-timeout",
                "the bridge did not answer",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_results_and_errors() {
        assert_eq!(
            parse_reply(br#"{"id":3,"ok":true,"result":{"souls":[]}}"#),
            Some((3, Ok(json!({ "souls": [] }))))
        );
        assert_eq!(
            parse_reply(
                br#"{"id":4,"ok":false,"error":{"code":"broker-unreachable","message":"down"}}"#
            ),
            Some((4, Err(BridgeError::new("broker-unreachable", "down"))))
        );
        assert_eq!(
            parse_reply(br#"{"id":5,"ok":false}"#),
            Some((5, Err(BridgeError::new("bridge-error", ""))))
        );
    }

    #[test]
    fn ignores_lines_without_a_request_id() {
        assert_eq!(parse_reply(b"not json"), None);
        assert_eq!(parse_reply(br#"{"id":null,"ok":false}"#), None);
    }

    #[test]
    fn settles_and_fails_pending_requests() {
        let bridge = Bridge::default();
        let (a, mut ra) = oneshot::channel();
        let (b, mut rb) = oneshot::channel();
        bridge.pending.lock().unwrap().insert(1, a);
        bridge.pending.lock().unwrap().insert(2, b);
        bridge.settle(1, Ok(json!(1)));
        bridge.settle(9, Ok(json!(9)));
        bridge.fail_all(&BridgeError::new("bridge-restarting", "x"));
        assert_eq!(ra.try_recv().unwrap(), Ok(json!(1)));
        assert_eq!(
            rb.try_recv().unwrap().unwrap_err().code,
            "bridge-restarting"
        );
        assert!(bridge.pending.lock().unwrap().is_empty());
    }
}
