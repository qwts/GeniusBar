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
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

/// The principal operations the web view may call; bridge.mjs holds the
/// same list and checks it again.
pub const METHODS: &[&str] = &["census", "send", "inbox", "ack", "launch", "launchStatus"];

/// GeniusBar's own agent-comms and agent-bot names (ADR-0004 decision 8,
/// agent-comms ADR-0059, agent-bot #302): the bridge, setup and the
/// services script all run with them, so the credential setup saves is the
/// one the bridge reads, and only GeniusBar's login services are touched.
pub const HOST_ENV: &[(&str, &str)] = &[
    ("AGENT_COMMS_SERVICE_LABEL", "app.geniusbar.broker"),
    ("AGENT_COMMS_CREDENTIAL_NAME", "app.geniusbar.principal"),
    ("AGENT_BOT_SERVICE_LABEL", "app.geniusbar.agent-bot"),
    // GeniusBar's daemon runs the souls it launches (ADR-0276).
    ("AGENT_BOT_EXECUTOR", "1"),
];

/// The shims that put the bundled agent-comms and agent-bot on a soul's PATH.
pub fn tool_path(resources: &std::path::Path) -> std::path::PathBuf {
    resources.join("bin")
}

/// The bundled npm, which the daemon uses to install soul harnesses.
pub fn npm_cli(resources: &std::path::Path) -> std::path::PathBuf {
    resources
        .join("components")
        .join("npm")
        .join("bin")
        .join("npm-cli.js")
}

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
    setting_up: AtomicBool,
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
        .envs(HOST_ENV.iter().copied())
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

/// Parses one setup line: progress to forward, or the final outcome.
pub fn parse_setup_line(line: &[u8]) -> Option<Result<Value, BridgeError>> {
    let value: Value = serde_json::from_slice(line).ok()?;
    match value.get("done").and_then(Value::as_bool) {
        None => Some(Ok(value)),
        Some(true) => Some(Ok(json!({ "done": true }))),
        Some(false) => {
            let field = |name: &str| value.get(name).and_then(Value::as_str).unwrap_or("");
            let code = Some(field("code"))
                .filter(|c| !c.is_empty())
                .unwrap_or("setup-failed");
            Some(Err(BridgeError::new(code, field("message"))))
        }
    }
}

/// First-run setup (#9), on the owner's click: runs `bridge/setup.mjs` in
/// the bundled Node and forwards its progress as `setup-progress` events.
#[tauri::command]
pub async fn setup<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Bridge>,
) -> Result<(), BridgeError> {
    if state.setting_up.swap(true, Ordering::SeqCst) {
        return Err(BridgeError::new(
            "setup-running",
            "setup is already running",
        ));
    }
    let outcome = run_setup(&app).await;
    state.setting_up.store(false, Ordering::SeqCst);
    outcome
}

async fn run_setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), BridgeError> {
    let unavailable = |e: String| BridgeError::new("setup-unavailable", &e);
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| unavailable(e.to_string()))?;
    let (mut events, _child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| unavailable(e.to_string()))?
        .envs(HOST_ENV.iter().copied())
        .env("AGENT_BOT_NPM", npm_cli(&resources))
        .env("AGENT_BOT_TOOL_PATH", tool_path(&resources))
        .args([
            resources.join("bridge").join("setup.mjs"),
            resources.join("components").join("agent-comms"),
            resources.join("components").join("agent-bot"),
        ])
        .spawn()
        .map_err(|e| unavailable(e.to_string()))?;
    let mut outcome = Err(BridgeError::new(
        "setup-failed",
        "setup ended without a result",
    ));
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(line) => match parse_setup_line(&line) {
                Some(Ok(value)) if value.get("done").is_some() => outcome = Ok(()),
                Some(Ok(progress)) => {
                    let _ = app.emit("setup-progress", progress);
                }
                Some(Err(error)) => outcome = Err(error),
                None => {}
            },
            CommandEvent::Stderr(line) => {
                eprintln!("setup: {}", String::from_utf8_lossy(&line).trim_end());
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    outcome
}

/// The services script's one-line result: `{ok: true, ...}` or
/// `{ok: false, code, message}`.
fn parse_services_output(stdout: &[u8]) -> Result<Value, BridgeError> {
    parse_script_output(
        stdout,
        "services-failed",
        "the services script gave no result",
    )
}

/// A one-shot script's last line: `{ok: true, ...}` or `{ok: false, code, message}`.
fn parse_script_output(stdout: &[u8], fallback: &str, silent: &str) -> Result<Value, BridgeError> {
    let line = stdout
        .split(|b| *b == b'\n')
        .rev()
        .find(|line| !line.iter().all(u8::is_ascii_whitespace))
        .unwrap_or_default();
    let value: Value =
        serde_json::from_slice(line).map_err(|_| BridgeError::new(fallback, silent))?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(value);
    }
    let field = |name: &str| value.get(name).and_then(Value::as_str).unwrap_or("");
    let code = Some(field("code"))
        .filter(|c| !c.is_empty())
        .unwrap_or(fallback);
    Err(BridgeError::new(code, field("message")))
}

/// Runs `bridge/services.mjs ACTION` in the bundled Node (#9).
async fn run_services<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<Value, BridgeError> {
    let unavailable = |e: String| BridgeError::new("services-unavailable", &e);
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| unavailable(e.to_string()))?;
    let components = resources.join("components");
    let mut command = app
        .shell()
        .sidecar("node")
        .map_err(|e| unavailable(e.to_string()))?
        .envs(HOST_ENV.iter().copied())
        .env("AGENT_BOT_NPM", npm_cli(&resources))
        .env("AGENT_BOT_TOOL_PATH", tool_path(&resources))
        // The version stamp tells a same-path bundle swap from "unchanged"
        // (#34); the reconcile cannot happen without it, so it is optional.
        .env(
            "GENIUSBAR_APP_VERSION",
            app.package_info().version.to_string(),
        );
    if let Ok(dir) = app.path().app_data_dir() {
        command = command.env("GENIUSBAR_SERVICES_STAMP", dir.join("services.json"));
    }
    let output = command
        .args([
            resources
                .join("bridge")
                .join("services.mjs")
                .into_os_string(),
            action.into(),
            components.join("agent-comms").into_os_string(),
            components.join("agent-bot").into_os_string(),
        ])
        .output()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    parse_services_output(&output.stdout)
}

/// The owner's explicit "Remove services" (#9): unloads and deletes
/// GeniusBar's broker and daemon login services. Never alongside setup.
#[tauri::command]
pub async fn remove_services<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Bridge>,
) -> Result<Value, BridgeError> {
    if state.setting_up.swap(true, Ordering::SeqCst) {
        return Err(BridgeError::new(
            "setup-running",
            "setup is already running",
        ));
    }
    let outcome = run_services(&app, "remove").await;
    state.setting_up.store(false, Ordering::SeqCst);
    outcome
}

/// Another install's broker and daemon (Homebrew's), so setup can offer to
/// move them over instead of running beside them (#41). Read-only.
#[tauri::command]
pub async fn inspect_services<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    run_services(&app, "inspect").await
}

/// The owner's explicit "Move to GeniusBar" (#41): stops another install's
/// broker and daemon and starts GeniusBar's in their place, or puts them
/// back if that fails. Never alongside setup.
#[tauri::command]
pub async fn migrate_services<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Bridge>,
) -> Result<Value, BridgeError> {
    if state.setting_up.swap(true, Ordering::SeqCst) {
        return Err(BridgeError::new(
            "setup-running",
            "setup is already running",
        ));
    }
    let outcome = run_services(&app, "migrate").await;
    state.setting_up.store(false, Ordering::SeqCst);
    outcome
}

/// The tools a command-line install may name with `replace`.
const CLI_TOOLS: &[&str] = &["agent-bot", "agent-comms"];

/// Runs `bridge/cli-tools.mjs ACTION` in the bundled Node (#41).
async fn run_cli_tools<R: Runtime>(
    app: &AppHandle<R>,
    action: &str,
    replace: &[String],
) -> Result<Value, BridgeError> {
    let unavailable = |e: String| BridgeError::new("tools-unavailable", &e);
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| unavailable(e.to_string()))?;
    let mut args = vec![
        resources
            .join("bridge")
            .join("cli-tools.mjs")
            .into_os_string(),
        action.into(),
        tool_path(&resources).into_os_string(),
    ];
    for name in replace {
        args.push("--replace".into());
        args.push(name.into());
    }
    let output = app
        .shell()
        .sidecar("node")
        .map_err(|e| unavailable(e.to_string()))?
        .args(args)
        .output()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    parse_script_output(
        &output.stdout,
        "tools-failed",
        "the tools script gave no result",
    )
}

/// "Install command-line tools" (#41): `status`, `install` (with `replace`
/// naming tools the user agreed to take over), or `uninstall`.
#[tauri::command]
pub async fn cli_tools<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    replace: Option<Vec<String>>,
) -> Result<Value, BridgeError> {
    let replace = replace.unwrap_or_default();
    if !["status", "install", "uninstall"].contains(&action.as_str())
        || replace
            .iter()
            .any(|name| !CLI_TOOLS.contains(&name.as_str()))
    {
        return Err(BridgeError::new(
            "usage",
            "unknown command-line tools action",
        ));
    }
    run_cli_tools(&app, &action, &replace).await
}

/// At launch, re-registers GeniusBar's services if they still run an older
/// or moved copy of the app (#9). Release builds only: a development build
/// lives in `target/` and must not take over the installed app's services.
pub fn refresh_services<R: Runtime>(app: AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Bridge>();
        if state.setting_up.swap(true, Ordering::SeqCst) {
            return;
        }
        match run_services(&app, "refresh").await {
            Ok(result) => eprintln!("services: {result}"),
            Err(error) => eprintln!("services: refresh failed: {} {}", error.code, error.message),
        }
        state.setting_up.store(false, Ordering::SeqCst);
        // Command-line wrappers the user installed follow the app if it moved (#41).
        if let Err(error) = run_cli_tools(&app, "refresh", &[]).await {
            eprintln!(
                "cli tools: refresh failed: {} {}",
                error.code, error.message
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_metrics_reads_snapshot_or_returns_unavailable() {
        let snapshot = json!({
            "collectedAt": "2026-10-03T12:00:00Z",
            "souls": { "agent_p": { "lastCallAt": null, "observations": [] } },
            "errors": [{ "agentId": "agent_p", "source": "claude", "code": "read-failed", "message": "failed" }],
            "missing": []
        });
        assert_eq!(
            parse_runtime_metrics(snapshot.to_string().as_bytes()),
            snapshot
        );
        for output in [
            b"".as_slice(),
            b"unknown command metrics",
            b"{}",
            b"{\"error\":{\"message\":\"failed\"}}",
        ] {
            assert_eq!(
                parse_runtime_metrics(output),
                json!({ "unavailable": true })
            );
        }
    }

    #[test]
    fn harness_auth_reads_sign_in_state_or_error() {
        let ok = parse_harness_auth(b"{\"harness\":\"claude\",\"loggedIn\":false}\n").unwrap();
        assert_eq!(ok["loggedIn"], false);
        let err =
            parse_harness_auth(b"{\"error\":{\"message\":\"claude sign-in did not finish\"}}\n")
                .unwrap_err();
        assert_eq!(err.message, "claude sign-in did not finish");
        assert!(parse_harness_auth(b"").is_err());
        assert!(parse_harness_auth(b"{\"harness\":\"claude\"}").is_err());
    }

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
    fn parses_setup_progress_and_outcomes() {
        let progress = json!({ "step": "broker", "state": "done" });
        assert_eq!(
            parse_setup_line(progress.to_string().as_bytes()),
            Some(Ok(progress))
        );
        assert_eq!(
            parse_setup_line(br#"{"done":true}"#),
            Some(Ok(json!({ "done": true })))
        );
        assert_eq!(
            parse_setup_line(br#"{"done":false,"code":"broker-not-ready","message":"late"}"#),
            Some(Err(BridgeError::new("broker-not-ready", "late")))
        );
        assert_eq!(parse_setup_line(b"noise"), None);
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

    #[test]
    fn parses_services_results() {
        assert_eq!(
            parse_services_output(b"{\"ok\":true,\"broker\":\"current\",\"daemon\":\"absent\"}\n"),
            Ok(json!({ "ok": true, "broker": "current", "daemon": "absent" }))
        );
        assert_eq!(
            parse_services_output(br#"{"ok":false,"code":"launchctl-failed","message":"busy"}"#),
            Err(BridgeError::new("launchctl-failed", "busy"))
        );
        assert_eq!(
            parse_services_output(b""),
            Err(BridgeError::new(
                "services-failed",
                "the services script gave no result"
            ))
        );
    }

    #[test]
    fn parses_cli_tools_results_with_their_own_fallback() {
        assert_eq!(
            parse_script_output(
                br#"{"ok":false,"code":"tools-conflict","message":"already on PATH"}"#,
                "tools-failed",
                "none"
            ),
            Err(BridgeError::new("tools-conflict", "already on PATH"))
        );
        assert_eq!(
            parse_script_output(b"{\"ok\":false}\n", "tools-failed", "none"),
            Err(BridgeError::new("tools-failed", ""))
        );
    }
}

/// A harness's sign-in for a soul (ADR-0276): `status` reports
/// `{harness, loggedIn}`; `login` runs the harness's own browser sign-in
/// first. Credentials stay in the harness's store.
#[tauri::command]
pub async fn harness_auth<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    harness: String,
    soul: String,
) -> Result<Value, BridgeError> {
    let unavailable = |e: String| BridgeError::new("harness-auth-unavailable", &e);
    if !matches!(action.as_str(), "status" | "login") {
        return Err(BridgeError::new(
            "harness-auth-invalid",
            "action must be status or login",
        ));
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| unavailable(e.to_string()))?;
    let output = app
        .shell()
        .sidecar("node")
        .map_err(|e| unavailable(e.to_string()))?
        .envs(HOST_ENV.iter().copied())
        .args([
            resources
                .join("components")
                .join("agent-bot")
                .join("agent-bot.mjs")
                .into_os_string(),
            "harness".into(),
            "auth".into(),
            action.into(),
            harness.into(),
            "--soul".into(),
            soul.into(),
        ])
        .output()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    parse_harness_auth(&output.stdout)
}

/// Metrics are optional: missing collectors or an older bundle never block messaging.
#[tauri::command]
pub async fn runtime_metrics<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let unavailable = json!({ "unavailable": true });
    let Ok(resources) = app.path().resource_dir() else {
        return Ok(unavailable);
    };
    let script = resources
        .join("components")
        .join("agent-bot")
        .join("agent-bot.mjs");
    for action in ["collect", "show"] {
        let Ok(command) = app.shell().sidecar("node") else {
            return Ok(unavailable);
        };
        let Ok(output) = command
            .envs(HOST_ENV.iter().copied())
            .args([
                script.clone().into_os_string(),
                "metrics".into(),
                action.into(),
                "--json".into(),
            ])
            .output()
            .await
        else {
            return Ok(unavailable);
        };
        if !output.status.success() {
            return Ok(unavailable);
        }
        if action == "show" {
            return Ok(parse_runtime_metrics(&output.stdout));
        }
    }
    Ok(unavailable)
}

fn parse_runtime_metrics(stdout: &[u8]) -> Value {
    let Ok(value) = serde_json::from_slice::<Value>(stdout) else {
        return json!({ "unavailable": true });
    };
    if value.get("collectedAt").is_none()
        || !value.get("souls").is_some_and(Value::is_object)
        || !value.get("errors").is_some_and(Value::is_array)
        || !value.get("missing").is_some_and(Value::is_array)
    {
        return json!({ "unavailable": true });
    }
    value
}

/// agent-bot's `harness auth` line: `{harness, loggedIn}` or `{error}`.
fn parse_harness_auth(stdout: &[u8]) -> Result<Value, BridgeError> {
    let failed = |message: &str| BridgeError::new("harness-auth-failed", message);
    let line = stdout
        .split(|b| *b == b'\n')
        .rev()
        .find(|line| !line.iter().all(u8::is_ascii_whitespace))
        .unwrap_or_default();
    let value: Value =
        serde_json::from_slice(line).map_err(|_| failed("agent-bot gave no result"))?;
    if let Some(error) = value.get("error") {
        return Err(failed(
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("sign-in failed"),
        ));
    }
    if value.get("loggedIn").and_then(Value::as_bool).is_none() {
        return Err(failed("agent-bot gave no sign-in state"));
    }
    Ok(value)
}
