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

/// The principal operations the web view may call, plus `auditExport` (local
/// glue that saves the audit JSON to ~/Downloads); bridge.mjs holds the same
/// list and checks it again.
pub const METHODS: &[&str] = &[
    "census",
    "send",
    "inbox",
    "ack",
    "launch",
    "launchStatus",
    "auditExport",
];

/// GeniusBar's own agent-comms and agent-bot names (ADR-0004 decision 8,
/// agent-comms ADR-0059, agent-bot #302): the bridge, setup and the
/// services script all run with them, so the credential setup saves is the
/// one the bridge reads, and only GeniusBar's login services are touched.
pub const HOST_ENV: &[(&str, &str)] = &[
    ("AGENT_COMMS_SERVICE_LABEL", "app.geniusbar.broker"),
    ("AGENT_COMMS_CREDENTIAL_NAME", "app.geniusbar.principal"),
    ("AGENT_BOT_SERVICE_LABEL", "app.geniusbar.agent-bot"),
    // agent-bot-keyd, GeniusBar's key custodian (agent-bot-identity #397).
    ("AGENT_BOT_KEYD_SERVICE_LABEL", "app.geniusbar.keyd"),
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
    /// Requests seen per method, so `shell.log` shows the page still asking (#223).
    calls: Mutex<HashMap<String, u64>>,
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
                Err(error) => {
                    crate::windows::log_line(&app, &format!("bridge failed to start: {error}"))
                }
            }
            let bridge = app.state::<Bridge>();
            bridge.child.lock().unwrap().take();
            crate::windows::log_line(
                &app,
                &format!(
                    "bridge exited after {} s; restarting in {} s",
                    started.elapsed().as_secs(),
                    backoff.as_secs()
                ),
            );
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
pub async fn bridge<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Bridge>,
    method: String,
    params: Option<Value>,
) -> Result<Value, BridgeError> {
    if !METHODS.contains(&method.as_str()) {
        return Err(BridgeError::new("bad-request", "unknown method"));
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let seen = {
        let mut calls = state.calls.lock().unwrap();
        let count = calls.entry(method.clone()).or_insert(0);
        *count += 1;
        *count
    };
    if seen == 1 || seen % 12 == 0 {
        crate::windows::log_line(&app, &format!("bridge {method} x{seen}"));
    }
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
        crate::windows::log_line(&app, &format!("bridge {method}: the bridge is not running"));
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
            crate::windows::log_line(
                &app,
                &format!(
                    "bridge {method}: no answer in {} s",
                    REQUEST_TIMEOUT.as_secs()
                ),
            );
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
            Ok(result) => crate::windows::log_line(&app, &format!("services: {result}")),
            Err(error) => crate::windows::log_line(
                &app,
                &format!("services: refresh failed: {} {}", error.code, error.message),
            ),
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
    fn parses_soul_comms_results_and_errors() {
        let shown =
            br#"{"agentId":"agent_1","name":"bill","managed":true,"comms":false,"running":false}"#;
        assert_eq!(parse_soul_comms(shown, b"").unwrap()["comms"], json!(false));
        assert_eq!(
            parse_soul_comms(
                b"",
                b"agent-bot soul comms: agent_1 is running; stop it first\n"
            ),
            Err(BridgeError::new(
                "soul-comms-failed",
                "agent_1 is running; stop it first"
            ))
        );
        assert_eq!(
            parse_soul_comms(b"{\"agentId\":\"agent_1\",\"comms\":true}\n", b""),
            Err(BridgeError::new(
                "soul-comms-failed",
                "agent-bot gave no comms state"
            ))
        );
    }

    #[test]
    fn parses_soul_locate_results_and_errors() {
        let installed = br#"{"path":"/s/A.soul","status":"installed","agentId":"agent_1","soulDir":"/s/A.soul","copies":[]}"#;
        assert_eq!(
            parse_soul_locate(installed, b"").unwrap()["agentId"],
            json!("agent_1")
        );
        assert_eq!(
            parse_soul_locate(b"{\"path\":\"/p.soul\",\"status\":\"package\"}\n", b"").unwrap()
                ["status"],
            json!("package")
        );
        assert_eq!(
            parse_soul_locate(b"{\"path\":\"/p.soul\",\"status\":\"installed\"}", b""),
            Err(BridgeError::new(
                "soul-locate-failed",
                "agent-bot gave no location"
            ))
        );
        assert_eq!(
            parse_soul_locate(b"{\"status\":\"elsewhere\",\"agentId\":\"agent_1\"}", b""),
            Err(BridgeError::new(
                "soul-locate-failed",
                "agent-bot gave no location"
            ))
        );
        // A bad marker names no soul; its refusal reaches the form (#110).
        let invalid = parse_soul_locate(
            br#"{"path":"/p.soul","status":"invalid","message":"/p.soul has an invalid soul marker"}"#,
            b"",
        )
        .unwrap();
        assert_eq!(invalid["status"], json!("invalid"));
        assert_eq!(
            invalid["message"],
            json!("/p.soul has an invalid soul marker")
        );
        assert_eq!(
            parse_soul_locate(
                br#"{"path":"/c.soul","status":"copy","agentId":"agent_1","name":"Bill"}"#,
                b""
            )
            .unwrap()["name"],
            json!("Bill")
        );
        // An older bundle has no `soul locate`: its usage error comes back.
        assert_eq!(
            parse_soul_locate(b"", b"agent-bot: usage: agent-bot soul cold-wake\n"),
            Err(BridgeError::new(
                "soul-locate-failed",
                "agent-bot: usage: agent-bot soul cold-wake"
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

/// A soul's managed and agent-comms state (#71), from agent-bot's
/// `soul comms <soul> show|on|off --json`: `{agentId, name, managed, comms,
/// running}`. agent-bot owns the rules: `on` and `off` ask the owner to
/// approve and are refused while the soul runs. GeniusBar only relays.
#[tauri::command]
pub async fn soul_comms<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    soul: String,
) -> Result<Value, BridgeError> {
    let unavailable = |e: String| BridgeError::new("soul-comms-unavailable", &e);
    if !matches!(action.as_str(), "show" | "on" | "off") {
        return Err(BridgeError::new(
            "soul-comms-invalid",
            "action must be show, on or off",
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
            "soul".into(),
            "comms".into(),
            soul.into(),
            action.into(),
            "--json".into(),
        ])
        .output()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    parse_soul_comms(&output.stdout, &output.stderr)
}

/// agent-bot's `soul comms --json` line, or its `agent-bot soul comms: …` error.
fn parse_soul_comms(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    let last = |bytes: &[u8]| -> String {
        String::from_utf8_lossy(
            bytes
                .split(|b| *b == b'\n')
                .rev()
                .find(|line| !line.iter().all(u8::is_ascii_whitespace))
                .unwrap_or_default(),
        )
        .trim()
        .to_string()
    };
    if let Ok(value) = serde_json::from_str::<Value>(&last(stdout)) {
        if value.get("agentId").and_then(Value::as_str).is_some()
            && ["managed", "comms", "running"]
                .iter()
                .all(|field| value.get(*field).and_then(Value::as_bool).is_some())
        {
            return Ok(value);
        }
    }
    let message = last(stderr);
    let message = message
        .strip_prefix("agent-bot soul comms: ")
        .unwrap_or(&message);
    Err(BridgeError::new(
        "soul-comms-failed",
        if message.is_empty() {
            "agent-bot gave no comms state"
        } else {
            message
        },
    ))
}

/// What a `.soul` opened from Finder is (#80), from agent-bot's
/// `soul locate PATH`: `{path, status, agentId?, soulDir?, copies?, message?}`
/// where status is package, installed, copy, duplicate, unregistered or invalid.
/// agent-bot owns the rules; an installed soul's own folder is that soul,
/// never a new launch. An older bundle without the command is an error the
/// UI ignores, keeping the package flow (the daemon applies the same rule).
#[tauri::command]
pub async fn locate_soul_package<R: Runtime>(
    app: AppHandle<R>,
    package: String,
) -> Result<Value, BridgeError> {
    let unavailable = |e: String| BridgeError::new("soul-locate-unavailable", &e);
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
            "soul".into(),
            "locate".into(),
            package.into(),
        ])
        .output()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    parse_soul_locate(&output.stdout, &output.stderr)
}

pub(crate) fn last_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(
        bytes
            .split(|b| *b == b'\n')
            .rev()
            .find(|line| !line.iter().all(u8::is_ascii_whitespace))
            .unwrap_or_default(),
    )
    .trim()
    .to_string()
}

const LOCATE_STATUSES: [&str; 6] = [
    "package",
    "installed",
    "copy",
    "duplicate",
    "unregistered",
    "invalid",
];

/// agent-bot's `soul locate` line, or its `soul locate: …` error.
fn parse_soul_locate(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if let Ok(value) = serde_json::from_str::<Value>(&last_line(stdout)) {
        let status = value.get("status").and_then(Value::as_str);
        let has_soul = value.get("agentId").and_then(Value::as_str).is_some();
        if status.is_some_and(|s| LOCATE_STATUSES.contains(&s))
            // A package, or an invalid marker (which names no soul), stands alone.
            && (matches!(status, Some("package" | "invalid")) || has_soul)
        {
            return Ok(value);
        }
    }
    let message = last_line(stderr);
    let message = message.strip_prefix("soul locate: ").unwrap_or(&message);
    Err(BridgeError::new(
        "soul-locate-failed",
        if message.is_empty() {
            "agent-bot gave no location"
        } else {
            message
        },
    ))
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

/// Runs the bundled agent-bot with `args` in GeniusBar's host environment.
pub(crate) async fn run_agent_bot<R: Runtime>(
    app: &AppHandle<R>,
    args: Vec<std::ffi::OsString>,
    unavailable_code: &str,
) -> Result<tauri_plugin_shell::process::Output, BridgeError> {
    let unavailable = |e: String| BridgeError::new(unavailable_code, &e);
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| unavailable(e.to_string()))?;
    let mut argv: Vec<std::ffi::OsString> = vec![resources
        .join("components")
        .join("agent-bot")
        .join("agent-bot.mjs")
        .into_os_string()];
    argv.extend(args);
    app.shell()
        .sidecar("node")
        .map_err(|e| unavailable(e.to_string()))?
        .envs(HOST_ENV.iter().copied())
        .args(argv)
        .output()
        .await
        .map_err(|e| unavailable(e.to_string()))
}

/// agent-bot's `--json` result line when `valid` accepts it; otherwise its
/// `{error: {code, message}}` line, or the last stderr line without
/// `prefix`, as a `failed` error.
fn parse_agent_bot_json(
    stdout: &[u8],
    stderr: &[u8],
    failed: &str,
    prefix: &str,
    fallback: &str,
    valid: fn(&Value) -> bool,
) -> Result<Value, BridgeError> {
    if let Ok(value) = serde_json::from_str::<Value>(&last_line(stdout)) {
        if valid(&value) {
            return Ok(value);
        }
        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_str).unwrap_or(failed);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(fallback);
            return Err(BridgeError::new(code, message));
        }
    }
    let message = last_line(stderr);
    let message = message.strip_prefix(prefix).unwrap_or(&message);
    Err(BridgeError::new(
        failed,
        if message.is_empty() {
            fallback
        } else {
            message
        },
    ))
}

/// The agent-comms messages that entered or left a soul's context (#122,
/// agent-bot-identity #404), from `soul asides <soul> [--after ID] --json`:
/// `{agentId, asides: [...], next}`. Read-only; agent-bot refuses a caller
/// carrying a soul marker, and GeniusBar runs as the owner.
#[tauri::command]
pub async fn soul_asides<R: Runtime>(
    app: AppHandle<R>,
    soul: String,
    after: Option<String>,
) -> Result<Value, BridgeError> {
    let mut args: Vec<std::ffi::OsString> = vec!["soul".into(), "asides".into(), soul.into()];
    if let Some(after) = after.filter(|a| !a.is_empty()) {
        args.push("--after".into());
        args.push(after.into());
    }
    args.push("--json".into());
    let output = run_agent_bot(&app, args, "soul-asides-unavailable").await?;
    parse_soul_asides(&output.stdout, &output.stderr)
}

fn parse_soul_asides(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-asides-failed",
        "agent-bot soul asides: ",
        "agent-bot gave no asides",
        |value| value.get("asides").is_some_and(Value::is_array),
    )
}

/// Tool-permission requests waiting on the owner (#85, #86), from agent-bot's
/// `approvals list --json` (`{approvals: [...]}`) and `approvals approve|deny
/// <proposalId> [--scope session] --json` (the decided proposal). The daemon
/// asks for the owner's presence (Touch ID) before a decision lands;
/// GeniusBar never does. `scope: "session"` (approve only, agent-bot-identity
/// #486) also grants that tool for the soul's current harness session; an
/// older bundle without `--scope` answers with its usage line, which maps to
/// `approval-scope-unsupported`.
#[tauri::command]
pub async fn approvals<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    proposal: Option<String>,
    scope: Option<String>,
) -> Result<Value, BridgeError> {
    let session = scope.as_deref() == Some("session");
    let args = approvals_args(&action, proposal, scope.as_deref())?;
    let output = run_agent_bot(&app, args, "approvals-unavailable").await?;
    let parsed = parse_approvals(&action, &output.stdout, &output.stderr);
    if session {
        scope_refused(parsed)
    } else {
        parsed
    }
}

fn approvals_args(
    action: &str,
    proposal: Option<String>,
    scope: Option<&str>,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    let mut args: Vec<std::ffi::OsString> = match (action, proposal, scope) {
        ("list", None, None) => vec!["approvals".into(), "list".into(), "--json".into()],
        ("approve", Some(id), None | Some("once" | "session"))
        | ("deny", Some(id), None | Some("once"))
            if !id.is_empty() && !id.starts_with('-') =>
        {
            vec!["approvals".into(), action.into(), id.into()]
        }
        _ => return Err(BridgeError::new(
            "approvals-invalid",
            "action must be list, or approve (scope once or session) or deny with a proposal id",
        )),
    };
    if action != "list" {
        // Once is agent-bot's default, so only a session grant names a scope:
        // an older bundle keeps working for every other decision.
        if scope == Some("session") {
            args.push("--scope".into());
            args.push("session".into());
        }
        args.push("--json".into());
    }
    Ok(args)
}

/// An older agent-bot's `approvals` usage line, which has no `--scope`, is a
/// refused session grant rather than a failed decision: nothing was decided.
fn scope_refused(parsed: Result<Value, BridgeError>) -> Result<Value, BridgeError> {
    match parsed {
        Err(error)
            if error.message.starts_with("usage: agent-bot approvals")
                && !error.message.contains("--scope") =>
        {
            Err(BridgeError::new(
                "approval-scope-unsupported",
                "this agent-bot cannot approve for the session; update agent-bot",
            ))
        }
        other => other,
    }
}

fn parse_approvals(action: &str, stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    let valid: fn(&Value) -> bool = if action == "list" {
        |value| value.get("approvals").is_some_and(Value::is_array)
    } else {
        |value| {
            value.get("proposalId").and_then(Value::as_str).is_some()
                && value.get("status").and_then(Value::as_str).is_some()
        }
    };
    parse_agent_bot_json(
        stdout,
        stderr,
        "approvals-failed",
        "agent-bot approvals: ",
        "agent-bot gave no approvals",
        valid,
    )
}

/// The audit log (#122), from agent-bot's `audit list --json [--agent ID]`:
/// `{records: [...]}`, newest last, each field already sanitized and bounded
/// by agent-bot. Read-only; without an agent it is the whole fleet's.
#[tauri::command]
pub async fn audit_list<R: Runtime>(
    app: AppHandle<R>,
    agent: Option<String>,
) -> Result<Value, BridgeError> {
    let args = audit_list_args(agent)?;
    let output = run_agent_bot(&app, args, "audit-unavailable").await?;
    parse_audit_list(&output.stdout, &output.stderr)
}

fn audit_list_args(agent: Option<String>) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    let mut args: Vec<std::ffi::OsString> = vec!["audit".into(), "list".into(), "--json".into()];
    match agent {
        None => {}
        Some(id) if !id.is_empty() && !id.starts_with('-') => {
            args.push("--agent".into());
            args.push(id.into());
        }
        Some(_) => {
            return Err(BridgeError::new(
                "audit-invalid",
                "agent must be an agent id",
            ))
        }
    }
    Ok(args)
}

fn parse_audit_list(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_agent_bot_json(
        stdout,
        stderr,
        "audit-failed",
        "agent-bot audit: ",
        "agent-bot gave no audit log",
        |value| value.get("records").is_some_and(Value::is_array),
    )
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    #[test]
    fn builds_audit_list_arguments() {
        assert_eq!(
            audit_list_args(None).unwrap(),
            vec!["audit", "list", "--json"]
        );
        assert_eq!(
            audit_list_args(Some("agent_1".into())).unwrap(),
            vec!["audit", "list", "--json", "--agent", "agent_1"]
        );
        assert_eq!(
            audit_list_args(Some("--limit".into())).unwrap_err().code,
            "audit-invalid"
        );
        assert_eq!(
            audit_list_args(Some(String::new())).unwrap_err().code,
            "audit-invalid"
        );
    }

    #[test]
    fn parses_audit_lists_or_their_error() {
        let list = parse_audit_list(
            b"{\"records\":[{\"at\":\"2026-10-05T10:00:00Z\",\"event\":\"permission\"}]}\n",
            b"",
        )
        .unwrap();
        assert_eq!(list["records"][0]["event"], "permission");
        assert_eq!(
            parse_audit_list(
                b"{\"error\":{\"code\":\"audit-failed\",\"message\":\"--limit must be an integer\"}}\n",
                b"agent-bot audit: --limit must be an integer\n"
            ),
            Err(BridgeError::new("audit-failed", "--limit must be an integer"))
        );
        // An older bundle without the command: its usage line comes back.
        assert_eq!(
            parse_audit_list(b"", b"agent-bot: usage: agent-bot soul cold-wake\n"),
            Err(BridgeError::new(
                "audit-failed",
                "agent-bot: usage: agent-bot soul cold-wake"
            ))
        );
        assert_eq!(
            parse_audit_list(b"", b""),
            Err(BridgeError::new(
                "audit-failed",
                "agent-bot gave no audit log"
            ))
        );
    }
}

#[cfg(test)]
mod chat_feed_tests {
    use super::*;

    #[test]
    fn parses_soul_asides_or_its_error() {
        let ok = parse_soul_asides(
            b"{\"agentId\":\"agent_1\",\"asides\":[{\"id\":\"aside_1\"}],\"next\":null}\n",
            b"",
        )
        .unwrap();
        assert_eq!(ok["asides"][0]["id"], "aside_1");
        assert_eq!(
            parse_soul_asides(
                b"{\"error\":{\"code\":\"not-owner\",\"message\":\"asides are for the owner\"}}\n",
                b"agent-bot soul asides: asides are for the owner\n"
            ),
            Err(BridgeError::new("not-owner", "asides are for the owner"))
        );
        // An older bundle without the command: its usage line comes back.
        assert_eq!(
            parse_soul_asides(b"", b"agent-bot: usage: agent-bot soul cold-wake\n"),
            Err(BridgeError::new(
                "soul-asides-failed",
                "agent-bot: usage: agent-bot soul cold-wake"
            ))
        );
        assert_eq!(
            parse_soul_asides(b"", b""),
            Err(BridgeError::new(
                "soul-asides-failed",
                "agent-bot gave no asides"
            ))
        );
    }

    #[test]
    fn parses_approval_lists_and_decisions() {
        let list = parse_approvals("list", b"{\"approvals\":[]}\n", b"").unwrap();
        assert!(list["approvals"].as_array().unwrap().is_empty());
        let decided = parse_approvals(
            "approve",
            b"{\"proposalId\":\"prop_1\",\"status\":\"approved\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(decided["status"], "approved");
        // A list result is not a decision.
        assert_eq!(
            parse_approvals("deny", b"{\"approvals\":[]}\n", b"")
                .unwrap_err()
                .code,
            "approvals-failed"
        );
        assert_eq!(
            parse_approvals(
                "deny",
                b"{\"error\":{\"code\":\"not-open\",\"message\":\"prop_1 is not waiting on a decision\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "not-open",
                "prop_1 is not waiting on a decision"
            ))
        );
    }

    #[test]
    fn approval_args_add_a_scope_only_for_a_session_grant() {
        let args = |action: &str, id: Option<&str>, scope: Option<&str>| {
            approvals_args(action, id.map(String::from), scope).map(|args| {
                args.iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        };
        assert_eq!(args("list", None, None).unwrap(), "approvals list --json");
        assert_eq!(
            args("approve", Some("prop_1"), None).unwrap(),
            "approvals approve prop_1 --json"
        );
        assert_eq!(
            args("approve", Some("prop_1"), Some("once")).unwrap(),
            "approvals approve prop_1 --json"
        );
        assert_eq!(
            args("approve", Some("prop_1"), Some("session")).unwrap(),
            "approvals approve prop_1 --scope session --json"
        );
        assert_eq!(
            args("deny", Some("prop_1"), None).unwrap(),
            "approvals deny prop_1 --json"
        );
        for (action, id, scope) in [
            ("deny", Some("prop_1"), Some("session")),
            ("approve", Some("prop_1"), Some("forever")),
            ("list", None, Some("session")),
            ("approve", Some("--scope"), None),
            ("approve", Some(""), None),
            ("approve", None, None),
            ("list", Some("prop_1"), None),
            ("expire", Some("prop_1"), None),
        ] {
            assert_eq!(
                args(action, id, scope).unwrap_err().code,
                "approvals-invalid",
                "{action} {id:?} {scope:?}"
            );
        }
    }

    #[test]
    fn maps_an_older_bundles_scope_refusal() {
        // agent-bot 0.10.20 has no --scope: its usage line comes back.
        let old = parse_approvals(
            "approve",
            b"{\"error\":{\"code\":\"approvals-failed\",\"message\":\"usage: agent-bot approvals list [--json] | approvals approve|deny <proposalId> [--json] [--principal-stdin]\"}}\n",
            b"agent-bot approvals: usage: agent-bot approvals list [--json] | approvals approve|deny <proposalId> [--json] [--principal-stdin]\n",
        );
        assert_eq!(
            scope_refused(old).unwrap_err().code,
            "approval-scope-unsupported"
        );
        // The same line on stderr alone (no JSON) is refused the same way.
        let old_stderr = parse_approvals(
            "approve",
            b"",
            b"agent-bot approvals: usage: agent-bot approvals list [--json] | approvals approve|deny <proposalId> [--json]\n",
        );
        assert_eq!(
            scope_refused(old_stderr).unwrap_err().code,
            "approval-scope-unsupported"
        );
        // A newer bundle's own usage names --scope and stays a plain failure.
        let new = parse_approvals(
            "approve",
            b"",
            b"agent-bot approvals: usage: agent-bot approvals list [--json] | approvals approve <proposalId> [--scope once|session] [--json]\n",
        );
        assert_eq!(scope_refused(new).unwrap_err().code, "approvals-failed");
        // Other refusals and successes pass through.
        let not_open = parse_approvals(
            "approve",
            b"{\"error\":{\"code\":\"not-open\",\"message\":\"prop_1 is not waiting on a decision\"}}\n",
            b"",
        );
        assert_eq!(scope_refused(not_open).unwrap_err().code, "not-open");
        let granted = parse_approvals(
            "approve",
            b"{\"proposalId\":\"prop_1\",\"status\":\"approved\",\"scope\":\"session\",\"decision\":\"approved_session\"}\n",
            b"",
        );
        assert_eq!(
            scope_refused(granted).unwrap()["decision"],
            "approved_session"
        );
    }
}

/// A soul's cold-wake setting (#122, Lovable "Wake on new messages"), from
/// agent-bot's `soul cold-wake <agentId> show --json`: `{agentId, setting,
/// policy, lane}`. `on` and `off` are owner-gated by agent-bot (its consent
/// dialog, Touch ID); GeniusBar never asks itself. agent-bot takes `--json`
/// only with `show`, so a change runs plain and the setting is read back.
#[tauri::command]
pub async fn soul_cold_wake<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    action: String,
) -> Result<Value, BridgeError> {
    let change = cold_wake_args(&agent, &action)?;
    if action != "show" {
        let output = run_agent_bot(&app, change, "cold-wake-unavailable").await?;
        if !output.status.success() {
            return Err(cold_wake_refusal(&output.stderr));
        }
    }
    let show = cold_wake_args(&agent, "show")?;
    let output = run_agent_bot(&app, show, "cold-wake-unavailable").await?;
    parse_cold_wake(&output.stdout, &output.stderr)
}

fn cold_wake_args(agent: &str, action: &str) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.is_empty() || agent.starts_with('-') {
        return Err(BridgeError::new(
            "cold-wake-invalid",
            "agent must be an agent id",
        ));
    }
    let mut args: Vec<std::ffi::OsString> = vec!["soul".into(), "cold-wake".into(), agent.into()];
    match action {
        "show" => args.extend(["show".into(), "--json".into()]),
        "on" | "off" => args.push(action.into()),
        _ => {
            return Err(BridgeError::new(
                "cold-wake-invalid",
                "action must be show, on or off",
            ))
        }
    }
    Ok(args)
}

/// Why agent-bot refused a cold-wake change: its stderr line, unprefixed.
fn cold_wake_refusal(stderr: &[u8]) -> BridgeError {
    let message = last_line(stderr);
    let message = message
        .strip_prefix("agent-bot soul cold-wake: ")
        .unwrap_or(&message);
    BridgeError::new(
        "cold-wake-failed",
        if message.is_empty() {
            "agent-bot did not change the wake setting"
        } else {
            message
        },
    )
}

fn parse_cold_wake(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_agent_bot_json(
        stdout,
        stderr,
        "cold-wake-failed",
        "agent-bot soul cold-wake: ",
        "agent-bot gave no wake setting",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some() && value.get("setting").is_some()
        },
    )
}

/// The facts agent-bot's population census keeps about one soul that the
/// broker's census does not (#122): its GitHub App slug, the harness sign-in
/// a daemon turn found missing or expired (#84), its role line, and the
/// brief its last launch saved (#120, agent-bot-identity #502), which the
/// launch dialog prefills on relaunch. From `population show <agentId>`
/// (pretty JSON); only those fields come back, so paths and transcript
/// locators never reach the web view.
#[tauri::command]
pub async fn soul_population<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
) -> Result<Value, BridgeError> {
    if agent.is_empty() || agent.starts_with('-') {
        return Err(BridgeError::new(
            "population-invalid",
            "agent must be an agent id",
        ));
    }
    let args: Vec<std::ffi::OsString> = vec!["population".into(), "show".into(), agent.into()];
    let output = run_agent_bot(&app, args, "population-unavailable").await?;
    parse_soul_population(&output.stdout, &output.stderr)
}

fn parse_soul_population(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if let Ok(value) = serde_json::from_slice::<Value>(stdout) {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            let field = |name: &str| value.get(name).cloned().unwrap_or(Value::Null);
            return Ok(json!({
                "agentId": id,
                "appSlug": field("appSlug"),
                "harnessAuth": field("harnessAuth"),
                "managed": field("managed"),
                "comms": field("comms"),
                "roleLine": field("roleLine"),
                "role": field("role"),
                "computerUse": field("computerUse"),
                "brief": field("brief"),
                "appearance": field("appearance"),
            }));
        }
    }
    let message = last_line(stderr);
    let message = message
        .strip_prefix("agent-population: ")
        .unwrap_or(&message);
    Err(BridgeError::new(
        "population-failed",
        if message.is_empty() {
            "agent-bot gave no census record"
        } else {
            message
        },
    ))
}

#[cfg(test)]
mod details_rows_tests {
    use super::*;

    #[test]
    fn builds_cold_wake_arguments() {
        assert_eq!(
            cold_wake_args("agent_1", "show").unwrap(),
            vec!["soul", "cold-wake", "agent_1", "show", "--json"]
        );
        // agent-bot takes --json only with show.
        assert_eq!(
            cold_wake_args("agent_1", "on").unwrap(),
            vec!["soul", "cold-wake", "agent_1", "on"]
        );
        assert_eq!(
            cold_wake_args("agent_1", "off").unwrap(),
            vec!["soul", "cold-wake", "agent_1", "off"]
        );
        assert_eq!(
            cold_wake_args("agent_1", "resume").unwrap_err().code,
            "cold-wake-invalid"
        );
        assert_eq!(
            cold_wake_args("--json", "show").unwrap_err().code,
            "cold-wake-invalid"
        );
        assert_eq!(
            cold_wake_args("", "show").unwrap_err().code,
            "cold-wake-invalid"
        );
    }

    #[test]
    fn parses_cold_wake_settings_or_their_error() {
        let on = parse_cold_wake(
            b"{\"agentId\":\"agent_1\",\"setting\":\"on\",\"policy\":null,\"lane\":\"acp\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(on["lane"], "acp");
        assert_eq!(
            parse_cold_wake(
                b"{\"error\":{\"code\":\"cold-wake-failed\",\"message\":\"cold wake settings are owner only\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "cold-wake-failed",
                "cold wake settings are owner only"
            ))
        );
        assert_eq!(
            parse_cold_wake(b"", b""),
            Err(BridgeError::new(
                "cold-wake-failed",
                "agent-bot gave no wake setting"
            ))
        );
        assert_eq!(
            cold_wake_refusal(b"agent-bot soul cold-wake: the owner did not approve\n"),
            BridgeError::new("cold-wake-failed", "the owner did not approve")
        );
        assert_eq!(
            cold_wake_refusal(b"").message,
            "agent-bot did not change the wake setting"
        );
    }

    #[test]
    fn keeps_only_the_details_fields_of_a_census_record() {
        let record = parse_soul_population(
            br#"{
  "id": "agent_1",
  "name": "luna",
  "appSlug": "luna-bot",
  "spacePath": "/Users/x/.agent-space",
  "transcriptLocator": {"provider": "claude", "id": "t1"},
  "managed": true,
  "comms": true,
  "harnessAuth": {"status": "expired", "harness": "claude", "since": "2026-10-05T10:00:00.000Z"},
  "role": "Release captain",
  "roleLine": "Release captain",
  "computerUse": false,
  "brief": "Review open PRs"
}
"#,
            b"",
        )
        .unwrap();
        assert_eq!(record["agentId"], "agent_1");
        assert_eq!(record["appSlug"], "luna-bot");
        assert_eq!(record["harnessAuth"]["status"], "expired");
        assert!(record.get("spacePath").is_none());
        assert!(record.get("transcriptLocator").is_none());
        let bare = parse_soul_population(b"{\"id\":\"agent_2\",\"appSlug\":null}", b"").unwrap();
        assert_eq!(bare["harnessAuth"], Value::Null);
        // `computerUse` (agent-bot-identity #482); an older record has none.
        assert_eq!(record["computerUse"], false);
        assert_eq!(bare["computerUse"], Value::Null);
        // The saved launch brief (agent-bot-identity #502); a soul launched
        // without one has none.
        assert_eq!(record["brief"], "Review open PRs");
        assert_eq!(bare["brief"], Value::Null);
        // The declared role (agent-bot-identity #535) beside its roleLine.
        assert_eq!(record["role"], "Release captain");
        assert_eq!(record["roleLine"], "Release captain");
        assert_eq!(bare["role"], Value::Null);
        assert_eq!(
            parse_soul_population(b"", b"agent-population: no population record for agent_3\n"),
            Err(BridgeError::new(
                "population-failed",
                "no population record for agent_3"
            ))
        );
    }
}

/// A soul's execution mode (#122, Lovable "Execution mode": Safe Mode or
/// Auto-Pilot), from agent-bot's `soul mode <agentId> show --json`:
/// `{agentId, mode}`. In Safe Mode risky and external tool calls wait for the
/// owner; in Auto-Pilot every call runs. `safe` and `autopilot` are
/// owner-gated by agent-bot (its consent dialog, Touch ID); GeniusBar never
/// asks itself. agent-bot answers a change with the mode it now holds.
#[tauri::command]
pub async fn soul_mode<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    action: String,
) -> Result<Value, BridgeError> {
    let args = soul_mode_args(&agent, &action)?;
    let output = run_agent_bot(&app, args, "soul-mode-unavailable").await?;
    parse_soul_mode(&output.stdout, &output.stderr)
}

fn soul_mode_args(agent: &str, action: &str) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.is_empty() || agent.starts_with('-') {
        return Err(BridgeError::new(
            "soul-mode-invalid",
            "agent must be an agent id",
        ));
    }
    if !matches!(action, "show" | "safe" | "autopilot") {
        return Err(BridgeError::new(
            "soul-mode-invalid",
            "action must be show, safe or autopilot",
        ));
    }
    Ok(vec![
        "soul".into(),
        "mode".into(),
        agent.into(),
        action.into(),
        "--json".into(),
    ])
}

fn parse_soul_mode(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-mode-failed",
        "agent-bot soul mode: ",
        "agent-bot gave no execution mode",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && matches!(
                    value.get("mode").and_then(Value::as_str),
                    Some("safe" | "autopilot")
                )
        },
    )
}

#[cfg(test)]
mod soul_mode_tests {
    use super::*;

    #[test]
    fn builds_soul_mode_arguments() {
        assert_eq!(
            soul_mode_args("agent_1", "show").unwrap(),
            vec!["soul", "mode", "agent_1", "show", "--json"]
        );
        assert_eq!(
            soul_mode_args("agent_1", "safe").unwrap(),
            vec!["soul", "mode", "agent_1", "safe", "--json"]
        );
        assert_eq!(
            soul_mode_args("agent_1", "autopilot").unwrap(),
            vec!["soul", "mode", "agent_1", "autopilot", "--json"]
        );
        for (agent, action) in [
            ("agent_1", "on"),
            ("agent_1", ""),
            ("--json", "show"),
            ("", "safe"),
        ] {
            assert_eq!(
                soul_mode_args(agent, action).unwrap_err().code,
                "soul-mode-invalid"
            );
        }
    }

    #[test]
    fn parses_soul_modes_or_their_error() {
        let mode =
            parse_soul_mode(b"{\"agentId\":\"agent_1\",\"mode\":\"autopilot\"}\n", b"").unwrap();
        assert_eq!(mode["mode"], "autopilot");
        assert_eq!(
            parse_soul_mode(
                b"{\"error\":{\"code\":\"soul-mode-failed\",\"message\":\"the owner did not approve\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "soul-mode-failed",
                "the owner did not approve"
            ))
        );
        assert_eq!(
            parse_soul_mode(
                b"",
                b"agent-bot soul mode: soul mode settings could not be read\n"
            ),
            Err(BridgeError::new(
                "soul-mode-failed",
                "soul mode settings could not be read"
            ))
        );
        // An older agent-bot without `soul mode`, or an unknown mode.
        assert_eq!(
            parse_soul_mode(b"{\"agentId\":\"agent_1\",\"mode\":\"yolo\"}\n", b"").unwrap_err(),
            BridgeError::new("soul-mode-failed", "agent-bot gave no execution mode")
        );
        assert_eq!(
            parse_soul_mode(b"", b"").unwrap_err().message,
            "agent-bot gave no execution mode"
        );
    }
}

/// A soul's computer-use switch (#122, Lovable "Toggle computer use"), from
/// agent-bot's `soul computer-use <agentId> show --json`
/// (agent-bot-identity #482): `{agentId, computerUse}`. Off, agent-bot
/// denies the soul's computer-use proposals; switching off while the soul
/// drives the screen also stops that session and adds `stopped: true`. `on`
/// and `off` are owner-gated by agent-bot exactly like `soul mode` (its
/// consent dialog, Touch ID); GeniusBar never asks itself. An older bundle
/// without the command answers with its `soul` usage line, which maps to
/// `soul-computer-use-unsupported`.
#[tauri::command]
pub async fn soul_computer_use<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    action: String,
) -> Result<Value, BridgeError> {
    let args = soul_computer_use_args(&agent, &action)?;
    let output = run_agent_bot(&app, args, "soul-computer-use-unavailable").await?;
    parse_soul_computer_use(&output.stdout, &output.stderr)
}

/// Whether the bundled agent-bot has `soul computer-use`: `{supported}`.
/// Runs the command with no soul, which changes nothing: a bundle that has
/// it answers with its own usage, an older one with the `soul` usage line.
#[tauri::command]
pub async fn soul_computer_use_probe<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = vec!["soul".into(), "computer-use".into(), "--json".into()];
    let output = run_agent_bot(&app, args, "soul-computer-use-unavailable").await?;
    parse_soul_computer_use_probe(&output.stdout, &output.stderr)
}

fn soul_computer_use_args(
    agent: &str,
    action: &str,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.is_empty() || agent.starts_with('-') {
        return Err(BridgeError::new(
            "soul-computer-use-invalid",
            "agent must be an agent id",
        ));
    }
    if !matches!(action, "show" | "on" | "off") {
        return Err(BridgeError::new(
            "soul-computer-use-invalid",
            "action must be show, on or off",
        ));
    }
    Ok(vec![
        "soul".into(),
        "computer-use".into(),
        agent.into(),
        action.into(),
        "--json".into(),
    ])
}

/// True when stderr is an older agent-bot's `soul` usage line, which does
/// not list `soul computer-use`.
fn soul_computer_use_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    let message = last_line(stderr);
    serde_json::from_str::<Value>(&last_line(stdout)).is_err()
        && message.contains("usage: agent-bot soul ")
        && !message.contains("soul computer-use")
}

fn parse_soul_computer_use(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_computer_use_missing(stdout, stderr) {
        return Err(BridgeError::new(
            "soul-computer-use-unsupported",
            "this agent-bot has no soul computer-use",
        ));
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-computer-use-failed",
        "agent-bot soul computer-use: ",
        "agent-bot gave no computer-use setting",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && value.get("computerUse").and_then(Value::as_bool).is_some()
        },
    )
}

fn parse_soul_computer_use_probe(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_computer_use_missing(stdout, stderr) {
        return Ok(json!({ "supported": false }));
    }
    match parse_soul_computer_use(stdout, stderr) {
        Err(error)
            if error
                .message
                .starts_with("usage: agent-bot soul computer-use") =>
        {
            Ok(json!({ "supported": true }))
        }
        Err(error) => Err(error),
        Ok(_) => Err(BridgeError::new(
            "soul-computer-use-failed",
            "agent-bot answered for a soul it was not asked about",
        )),
    }
}

#[cfg(test)]
mod soul_computer_use_tests {
    use super::*;

    /// agent-bot 0.10.19's `soul` usage line: it has `soul mode` and `soul
    /// pause`, but no `soul computer-use`.
    const OLD_USAGE: &[u8] =
        b"agent-bot: usage: agent-bot soul cold-wake <agentId> [on|off|show] | soul mode <agentId|name> [show|safe|autopilot] [--json] [--principal-stdin] | soul stop <agentId|name> [--json] | soul pause|resume <agentId|name> [--json]\n";

    #[test]
    fn builds_soul_computer_use_arguments() {
        for action in ["show", "on", "off"] {
            assert_eq!(
                soul_computer_use_args("agent_1", action).unwrap(),
                vec!["soul", "computer-use", "agent_1", action, "--json"]
            );
        }
        for (agent, action) in [
            ("agent_1", "safe"),
            ("agent_1", ""),
            ("agent_1", "true"),
            ("--json", "show"),
            ("-x", "on"),
            ("", "off"),
        ] {
            assert_eq!(
                soul_computer_use_args(agent, action).unwrap_err().code,
                "soul-computer-use-invalid"
            );
        }
    }

    #[test]
    fn parses_settings_or_their_error() {
        let shown =
            parse_soul_computer_use(b"{\"agentId\":\"agent_1\",\"computerUse\":true}\n", b"")
                .unwrap();
        assert_eq!(shown["computerUse"], true);
        let off = parse_soul_computer_use(
            b"{\"agentId\":\"agent_1\",\"computerUse\":false,\"stopped\":true}\n",
            b"",
        )
        .unwrap();
        assert_eq!(off["computerUse"], false);
        assert_eq!(off["stopped"], true);
        assert_eq!(
            parse_soul_computer_use(
                b"{\"error\":{\"code\":\"soul-computer-use-failed\",\"message\":\"the owner did not approve\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "soul-computer-use-failed",
                "the owner did not approve"
            ))
        );
        assert_eq!(
            parse_soul_computer_use(
                b"",
                b"agent-bot soul computer-use: no population record for agent_9\n"
            ),
            Err(BridgeError::new(
                "soul-computer-use-failed",
                "no population record for agent_9"
            ))
        );
        assert_eq!(
            parse_soul_computer_use(b"{\"agentId\":\"agent_1\",\"computerUse\":\"on\"}\n", b"")
                .unwrap_err(),
            BridgeError::new(
                "soul-computer-use-failed",
                "agent-bot gave no computer-use setting"
            )
        );
        assert_eq!(
            parse_soul_computer_use(b"", b"").unwrap_err().message,
            "agent-bot gave no computer-use setting"
        );
    }

    #[test]
    fn an_older_bundle_is_unsupported_not_failed() {
        assert_eq!(
            parse_soul_computer_use(b"", OLD_USAGE).unwrap_err().code,
            "soul-computer-use-unsupported"
        );
        assert_eq!(
            parse_soul_computer_use_probe(b"", OLD_USAGE).unwrap(),
            json!({ "supported": false })
        );
    }

    #[test]
    fn probes_a_bundle_with_soul_computer_use() {
        assert_eq!(
            parse_soul_computer_use_probe(
                b"{\"error\":{\"code\":\"soul-computer-use-failed\",\"message\":\"usage: agent-bot soul computer-use <agentId|name> [show|on|off] [--json] [--principal-stdin]\"}}\n",
                b""
            )
            .unwrap(),
            json!({ "supported": true })
        );
        assert_eq!(
            parse_soul_computer_use_probe(b"", b"").unwrap_err().code,
            "soul-computer-use-failed"
        );
        assert_eq!(
            parse_soul_computer_use_probe(b"{\"agentId\":\"agent_1\",\"computerUse\":true}\n", b"")
                .unwrap_err()
                .code,
            "soul-computer-use-failed"
        );
    }
}

/// GeniusBar's Sandboxing switch (#66), from agent-bot's `sandbox status
/// --json` (agent-bot-identity #376): `{enabled, provider, account, status,
/// checks, steps, souls}`. `status` is `unsupported`, `missing`, `creating`
/// or `ready`; `steps` are the owner's own steps to create and onboard the
/// account (agent-bot never creates it); `souls` says what each soul runs
/// as. Read-only. An older bundle without the command answers `unknown
/// command: sandbox`, which maps to `sandbox-unsupported` and hides the
/// feature.
#[tauri::command]
pub async fn sandbox_status<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = vec!["sandbox".into(), "status".into(), "--json".into()];
    let output = run_agent_bot(&app, args, "sandbox-unavailable").await?;
    parse_sandbox_status(&output.stdout, &output.stderr)
}

/// Turns the sandbox on or off (`action` `on` / `off`), or names its account
/// (`action` `account` with `account`). Owner-gated by agent-bot exactly
/// like `soul mode` (its consent dialog, Touch ID); GeniusBar never asks
/// itself. agent-bot answers with `{enabled, provider, account}`.
#[tauri::command]
pub async fn sandbox_set<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    account: Option<String>,
) -> Result<Value, BridgeError> {
    let args = sandbox_set_args(&action, account.as_deref())?;
    let output = run_agent_bot(&app, args, "sandbox-unavailable").await?;
    parse_sandbox_set(&output.stdout, &output.stderr)
}

/// A soul's sandbox override (`show`, `inherit`, `sandboxed` or
/// `unrestricted`), from `sandbox override <agentId> <action> --json`:
/// `{agentId, name, override, sandboxed, runsAs, source}`. A change is
/// owner-gated by agent-bot as `sandbox_set` is.
#[tauri::command]
pub async fn sandbox_override<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    action: String,
) -> Result<Value, BridgeError> {
    let args = sandbox_override_args(&agent, &action)?;
    let output = run_agent_bot(&app, args, "sandbox-unavailable").await?;
    parse_sandbox_override(&output.stdout, &output.stderr)
}

/// agent-bot's own rule for a sandbox account name, `^[a-z_][a-z0-9_-]{0,30}$`:
/// a short macOS account name that lands in argv, never a shell.
/// The pairings the broker knows (#66): `agent-comms broker pairings`, on
/// the owner's private admin socket, answers `{pairings: [{account, kind?,
/// uid, state, at, hardened?, code?}]}`; a pending one carries the code the
/// account printed. Read-only.
#[tauri::command]
pub async fn sandbox_pairings<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = vec!["broker".into(), "pairings".into()];
    let output = run_agent_comms(&app, args, "sandbox-unavailable").await?;
    parse_agent_comms_json(
        &output.stdout,
        &output.stderr,
        "agent-comms gave no pairings",
        |value| value.get("pairings").and_then(Value::as_array).is_some(),
    )
}

/// Approves a pending pairing by its code (`agent-comms broker approve
/// CODE`), the owner's own step from the Sandboxing card; the broker
/// answers `{account, state: "approved"}` (with `kind: "daemon"` for a
/// daemon's). GeniusBar runs as the owner, whose admin socket this is.
#[tauri::command]
pub async fn sandbox_approve<R: Runtime>(
    app: AppHandle<R>,
    code: String,
) -> Result<Value, BridgeError> {
    let code = pairing_code(&code)?;
    let args = vec!["broker".into(), "approve".into(), code.into()];
    let output = run_agent_comms(&app, args, "sandbox-unavailable").await?;
    parse_agent_comms_json(
        &output.stdout,
        &output.stderr,
        "agent-comms did not approve the pairing",
        |value| {
            value.get("account").and_then(Value::as_str).is_some()
                && value.get("state").and_then(Value::as_str) == Some("approved")
        },
    )
}

/// A pairing code as the broker mints them: six characters from its
/// alphabet (no 0, O, 1, I), upper-cased here so a typed code passes too.
fn pairing_code(code: &str) -> Result<String, BridgeError> {
    let code = code.trim().to_ascii_uppercase();
    let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    if code.len() == 6 && code.chars().all(|c| alphabet.contains(c)) {
        Ok(code)
    } else {
        Err(BridgeError::new(
            "sandbox-invalid",
            "a pairing code is six letters or digits",
        ))
    }
}

/// Runs the bundled agent-comms (`bin/agent-comms.mjs`) as `run_agent_bot`
/// runs agent-bot: GeniusBar's host env names its broker.
pub(crate) async fn run_agent_comms<R: Runtime>(
    app: &AppHandle<R>,
    args: Vec<std::ffi::OsString>,
    unavailable_code: &str,
) -> Result<tauri_plugin_shell::process::Output, BridgeError> {
    let unavailable = |e: String| BridgeError::new(unavailable_code, &e);
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| unavailable(e.to_string()))?;
    let mut argv: Vec<std::ffi::OsString> = vec![resources
        .join("components")
        .join("agent-comms")
        .join("bin")
        .join("agent-comms.mjs")
        .into_os_string()];
    argv.extend(args);
    app.shell()
        .sidecar("node")
        .map_err(|e| unavailable(e.to_string()))?
        .envs(HOST_ENV.iter().copied())
        .args(argv)
        .output()
        .await
        .map_err(|e| unavailable(e.to_string()))
}

/// agent-comms prints one pretty JSON document: its answer when `valid`
/// accepts it, or `{ok: false, error: {code, message}}` on a refusal (also
/// on stderr as `agent-comms: message`). Anything else is `sandbox-failed`
/// with the last stderr line.
fn parse_agent_comms_json(
    stdout: &[u8],
    stderr: &[u8],
    fallback: &str,
    valid: fn(&Value) -> bool,
) -> Result<Value, BridgeError> {
    if let Ok(value) = serde_json::from_slice::<Value>(stdout) {
        if valid(&value) {
            return Ok(value);
        }
        if let Some(error) = value
            .get("error")
            .filter(|_| value.get("ok") == Some(&Value::Bool(false)))
        {
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("sandbox-failed");
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(fallback);
            return Err(BridgeError::new(code, message));
        }
    }
    let line = last_line(stderr);
    let message = line.strip_prefix("agent-comms: ").unwrap_or(&line);
    Err(BridgeError::new(
        "sandbox-failed",
        if message.is_empty() {
            fallback
        } else {
            message
        },
    ))
}

fn valid_sandbox_account(name: &str) -> bool {
    let bytes = name.as_bytes();
    match bytes.split_first() {
        Some((first, rest)) => {
            (first.is_ascii_lowercase() || *first == b'_')
                && rest.len() <= 30
                && rest.iter().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-'
                })
        }
        None => false,
    }
}

fn sandbox_set_args(
    action: &str,
    account: Option<&str>,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    let invalid = |message: &str| BridgeError::new("sandbox-invalid", message);
    let mut args: Vec<std::ffi::OsString> = vec!["sandbox".into()];
    match (action, account) {
        ("on" | "off", None) => args.push(action.into()),
        ("account", Some(name)) if valid_sandbox_account(name) => {
            args.push("account".into());
            args.push(name.into());
        }
        ("account", _) => {
            return Err(invalid(
                "account must be a short macOS account name (lowercase letters, digits, _ and -)",
            ))
        }
        _ => return Err(invalid("action must be on, off or account NAME")),
    }
    args.push("--json".into());
    Ok(args)
}

fn sandbox_override_args(
    agent: &str,
    action: &str,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.is_empty() || agent.starts_with('-') {
        return Err(BridgeError::new(
            "sandbox-invalid",
            "agent must be an agent id",
        ));
    }
    if !matches!(action, "show" | "inherit" | "sandboxed" | "unrestricted") {
        return Err(BridgeError::new(
            "sandbox-invalid",
            "action must be show, inherit, sandboxed or unrestricted",
        ));
    }
    Ok(vec![
        "sandbox".into(),
        "override".into(),
        agent.into(),
        action.into(),
        "--json".into(),
    ])
}

/// True when stderr is an older agent-bot's answer to a command it lacks.
fn sandbox_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    serde_json::from_str::<Value>(&last_line(stdout)).is_err()
        && last_line(stderr).contains("unknown command: sandbox")
}

fn parse_sandbox(
    stdout: &[u8],
    stderr: &[u8],
    fallback: &str,
    valid: fn(&Value) -> bool,
) -> Result<Value, BridgeError> {
    if sandbox_missing(stdout, stderr) {
        return Err(BridgeError::new(
            "sandbox-unsupported",
            "this agent-bot has no sandbox",
        ));
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "sandbox-failed",
        "agent-bot sandbox: ",
        fallback,
        valid,
    )
}

fn parse_sandbox_status(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_sandbox(
        stdout,
        stderr,
        "agent-bot gave no sandbox status",
        |value| {
            value.get("enabled").and_then(Value::as_bool).is_some()
                && value.get("account").and_then(Value::as_str).is_some()
                && matches!(
                    value.get("status").and_then(Value::as_str),
                    Some("unsupported" | "missing" | "creating" | "ready")
                )
                && value.get("steps").and_then(Value::as_array).is_some()
                && value.get("souls").and_then(Value::as_array).is_some()
        },
    )
}

fn parse_sandbox_set(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_sandbox(
        stdout,
        stderr,
        "agent-bot gave no sandbox setting",
        |value| {
            value.get("enabled").and_then(Value::as_bool).is_some()
                && value.get("account").and_then(Value::as_str).is_some()
        },
    )
}

fn parse_sandbox_override(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_sandbox(
        stdout,
        stderr,
        "agent-bot gave no sandbox override",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && matches!(
                    value.get("override").and_then(Value::as_str),
                    Some("inherit" | "sandboxed" | "unrestricted")
                )
                && value.get("sandboxed").and_then(Value::as_bool).is_some()
                && value.get("runsAs").and_then(Value::as_str).is_some()
        },
    )
}

#[cfg(test)]
mod sandbox_tests {
    use super::*;

    /// What agent-bot 0.10.23 says to `sandbox`, which it does not have.
    const OLD: &[u8] = b"agent-bot: unknown command: sandbox\n";

    #[test]
    fn builds_sandbox_set_arguments() {
        assert_eq!(
            sandbox_set_args("on", None).unwrap(),
            vec!["sandbox", "on", "--json"]
        );
        assert_eq!(
            sandbox_set_args("off", None).unwrap(),
            vec!["sandbox", "off", "--json"]
        );
        assert_eq!(
            sandbox_set_args("account", Some("geniusbar-agent")).unwrap(),
            vec!["sandbox", "account", "geniusbar-agent", "--json"]
        );
        assert_eq!(
            sandbox_set_args("account", Some("_a")).unwrap(),
            vec!["sandbox", "account", "_a", "--json"]
        );
        let longest = format!("a{}", "b".repeat(30));
        assert!(sandbox_set_args("account", Some(&longest)).is_ok());
        let too_long = format!("a{}", "b".repeat(31));
        for (action, account) in [
            ("account", None),
            ("account", Some("")),
            ("account", Some("Agent")),
            ("account", Some("1agent")),
            ("account", Some("-agent")),
            ("account", Some("a b")),
            ("account", Some("a;rm")),
            ("account", Some("agent.x")),
            ("account", Some(too_long.as_str())),
            ("on", Some("agent")),
            ("status", None),
            ("", None),
        ] {
            assert_eq!(
                sandbox_set_args(action, account).unwrap_err().code,
                "sandbox-invalid",
                "{action} {account:?}"
            );
        }
    }

    #[test]
    fn accepts_a_pairing_code_as_the_broker_mints_it() {
        assert_eq!(pairing_code(" ab2c9z ").unwrap(), "AB2C9Z");
        for bad in ["", "ABCDE", "ABCDEFG", "ABC0EF", "ABCOEF", "ABC-EF"] {
            assert_eq!(pairing_code(bad).unwrap_err().code, "sandbox-invalid");
        }
    }

    #[test]
    fn reads_agent_comms_answers_and_refusals() {
        let ok = parse_agent_comms_json(
            b"{\n  \"pairings\": [\n    { \"account\": \"geniusbar-agent\", \"state\": \"pending\", \"code\": \"AB2C9Z\" }\n  ]\n}\n",
            b"",
            "no pairings",
            |v| v.get("pairings").and_then(Value::as_array).is_some(),
        )
        .unwrap();
        assert_eq!(ok["pairings"][0]["code"], "AB2C9Z");
        let refused = parse_agent_comms_json(
            b"{ \"ok\": false, \"error\": { \"code\": \"unknown-code\", \"message\": \"no pending pairing has that code\" } }\n",
            b"agent-comms: no pending pairing has that code\n",
            "not approved",
            |v| v.get("state").and_then(Value::as_str) == Some("approved"),
        )
        .unwrap_err();
        assert_eq!(refused.code, "unknown-code");
        assert_eq!(refused.message, "no pending pairing has that code");
        let broken = parse_agent_comms_json(
            b"",
            b"agent-comms: broker-unreachable: no broker socket\n",
            "no pairings",
            |_| true,
        )
        .unwrap_err();
        assert_eq!(broken.code, "sandbox-failed");
        assert_eq!(broken.message, "broker-unreachable: no broker socket");
        let silent = parse_agent_comms_json(b"", b"", "no pairings", |_| true).unwrap_err();
        assert_eq!(silent.message, "no pairings");
    }

    #[test]
    fn builds_sandbox_override_arguments() {
        for action in ["show", "inherit", "sandboxed", "unrestricted"] {
            assert_eq!(
                sandbox_override_args("agent_1", action).unwrap(),
                vec!["sandbox", "override", "agent_1", action, "--json"]
            );
        }
        for (agent, action) in [
            ("agent_1", "always"),
            ("agent_1", ""),
            ("agent_1", "on"),
            ("--json", "show"),
            ("-x", "inherit"),
            ("", "sandboxed"),
        ] {
            assert_eq!(
                sandbox_override_args(agent, action).unwrap_err().code,
                "sandbox-invalid"
            );
        }
    }

    #[test]
    fn parses_status_or_its_error() {
        let status = parse_sandbox_status(
            br#"{"enabled":true,"provider":"standard_macos_account","account":"geniusbar-agent","status":"missing","owner":"me","checks":{"exists":false},"steps":[{"id":"create-account","title":"Create","run":"owner-admin","commands":["x"],"done":false}],"souls":[]}
"#,
            b"",
        )
        .unwrap();
        assert_eq!(status["status"], "missing");
        assert_eq!(status["steps"][0]["id"], "create-account");
        assert_eq!(
            parse_sandbox_status(
                b"{\"error\":{\"code\":\"sandbox-failed\",\"message\":\"unknown sandbox provider: x\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "sandbox-failed",
                "unknown sandbox provider: x"
            ))
        );
        assert_eq!(
            parse_sandbox_status(
                b"{\"enabled\":true,\"account\":\"a\",\"status\":\"done\",\"steps\":[],\"souls\":[]}\n",
                b""
            )
            .unwrap_err(),
            BridgeError::new("sandbox-failed", "agent-bot gave no sandbox status")
        );
        assert_eq!(
            parse_sandbox_status(b"", b"agent-bot: config could not be read\n")
                .unwrap_err()
                .message,
            "agent-bot: config could not be read"
        );
    }

    #[test]
    fn parses_settings_and_overrides_or_their_refusal() {
        let set = parse_sandbox_set(
            b"{\"enabled\":true,\"provider\":\"standard_macos_account\",\"account\":\"geniusbar-agent\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(set["enabled"], true);
        assert_eq!(
            parse_sandbox_set(
                b"{\"error\":{\"code\":\"owner-approval-denied\",\"message\":\"the owner did not approve\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "owner-approval-denied",
                "the owner did not approve"
            ))
        );
        let shown = parse_sandbox_override(
            b"{\"agentId\":\"agent_1\",\"name\":\"luna\",\"override\":\"sandboxed\",\"sandboxed\":true,\"runsAs\":\"geniusbar-agent\",\"source\":\"override\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(shown["runsAs"], "geniusbar-agent");
        assert_eq!(
            parse_sandbox_override(
                b"{\"agentId\":\"agent_1\",\"override\":\"always\",\"sandboxed\":true,\"runsAs\":\"x\"}\n",
                b""
            )
            .unwrap_err(),
            BridgeError::new("sandbox-failed", "agent-bot gave no sandbox override")
        );
        assert_eq!(
            parse_sandbox_override(b"", b"").unwrap_err().message,
            "agent-bot gave no sandbox override"
        );
    }

    #[test]
    fn an_older_bundle_is_unsupported_not_failed() {
        for parse in [
            parse_sandbox_status,
            parse_sandbox_set,
            parse_sandbox_override,
        ] {
            assert_eq!(parse(b"", OLD).unwrap_err().code, "sandbox-unsupported");
        }
    }
}

/// Stops a soul's running turn (#122, Lovable computer-use Stop), with
/// agent-bot's `soul stop <agentId> --json` (agent-bot-identity #474):
/// `{agentId, stopped, reason?}`. The daemon cancels the turn cooperatively
/// and drops the soul from `busy` / `computerUse` once it settles. Not
/// owner-gated by Touch ID. An older bundle without the command answers with
/// its `soul` usage line, which maps to `soul-stop-unsupported`.
#[tauri::command]
pub async fn soul_stop<R: Runtime>(app: AppHandle<R>, agent: String) -> Result<Value, BridgeError> {
    let args = soul_stop_args(&agent)?;
    let output = run_agent_bot(&app, args, "soul-stop-unavailable").await?;
    parse_soul_stop(&output.stdout, &output.stderr)
}

/// Whether the bundled agent-bot has `soul stop`: `{supported}`. Runs the
/// command with no soul, which stops nothing: a bundle that has it answers
/// with its own `soul stop` usage, an older one with the `soul` usage line.
#[tauri::command]
pub async fn soul_stop_probe<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = vec!["soul".into(), "stop".into(), "--json".into()];
    let output = run_agent_bot(&app, args, "soul-stop-unavailable").await?;
    parse_soul_stop_probe(&output.stdout, &output.stderr)
}

fn soul_stop_args(agent: &str) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.is_empty() || agent.starts_with('-') {
        return Err(BridgeError::new(
            "soul-stop-invalid",
            "agent must be an agent id",
        ));
    }
    Ok(vec![
        "soul".into(),
        "stop".into(),
        agent.into(),
        "--json".into(),
    ])
}

/// True when stderr is an older agent-bot's `soul` usage line, which does
/// not list `soul stop`.
fn soul_stop_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    let message = last_line(stderr);
    serde_json::from_str::<Value>(&last_line(stdout)).is_err()
        && message.contains("usage: agent-bot soul ")
        && !message.contains("soul stop")
}

fn parse_soul_stop(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_stop_missing(stdout, stderr) {
        return Err(BridgeError::new(
            "soul-stop-unsupported",
            "this agent-bot has no soul stop",
        ));
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-stop-failed",
        "agent-bot soul stop: ",
        "agent-bot gave no stop result",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && value.get("stopped").and_then(Value::as_bool).is_some()
        },
    )
}

fn parse_soul_stop_probe(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_stop_missing(stdout, stderr) {
        return Ok(serde_json::json!({ "supported": false }));
    }
    match parse_soul_stop(stdout, stderr) {
        Err(error) if error.message.starts_with("usage: agent-bot soul stop") => {
            Ok(serde_json::json!({ "supported": true }))
        }
        Err(error) => Err(error),
        Ok(_) => Err(BridgeError::new(
            "soul-stop-failed",
            "agent-bot stopped a soul it was not asked to",
        )),
    }
}

#[cfg(test)]
mod soul_stop_tests {
    use super::*;

    const OLD_USAGE: &[u8] =
        b"agent-bot: usage: agent-bot soul cold-wake <agentId> [on|off|show] | soul mode <agentId|name> [show|safe|autopilot] [--json]\n";

    #[test]
    fn builds_soul_stop_arguments() {
        assert_eq!(
            soul_stop_args("agent_1").unwrap(),
            vec!["soul", "stop", "agent_1", "--json"]
        );
        for agent in ["", "--json", "-x"] {
            assert_eq!(soul_stop_args(agent).unwrap_err().code, "soul-stop-invalid");
        }
    }

    #[test]
    fn parses_stop_results_or_their_error() {
        let stopped =
            parse_soul_stop(b"{\"agentId\":\"agent_1\",\"stopped\":true}\n", b"").unwrap();
        assert_eq!(stopped["stopped"], true);
        let idle = parse_soul_stop(
            b"{\"agentId\":\"agent_1\",\"stopped\":false,\"reason\":\"idle\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(idle["reason"], "idle");
        assert_eq!(
            parse_soul_stop(
                b"{\"error\":{\"code\":\"daemon-unavailable\",\"message\":\"the daemon is not running\"}}\n",
                b"agent-bot soul stop: the daemon is not running\n"
            ),
            Err(BridgeError::new(
                "daemon-unavailable",
                "the daemon is not running"
            ))
        );
        assert_eq!(
            parse_soul_stop(
                b"",
                b"agent-bot soul stop: no population record for agent_9\n"
            ),
            Err(BridgeError::new(
                "soul-stop-failed",
                "no population record for agent_9"
            ))
        );
        assert_eq!(
            parse_soul_stop(b"{\"agentId\":\"agent_1\"}\n", b"").unwrap_err(),
            BridgeError::new("soul-stop-failed", "agent-bot gave no stop result")
        );
    }

    #[test]
    fn an_older_bundle_is_unsupported_not_failed() {
        assert_eq!(
            parse_soul_stop(b"", OLD_USAGE).unwrap_err().code,
            "soul-stop-unsupported"
        );
        assert_eq!(
            parse_soul_stop_probe(b"", OLD_USAGE).unwrap(),
            serde_json::json!({ "supported": false })
        );
    }

    #[test]
    fn probes_a_bundle_with_soul_stop() {
        assert_eq!(
            parse_soul_stop_probe(
                b"{\"error\":{\"code\":\"soul-stop-failed\",\"message\":\"usage: agent-bot soul stop <agentId|name> [--json]\"}}\n",
                b"agent-bot soul stop: usage: agent-bot soul stop <agentId|name> [--json]\n"
            )
            .unwrap(),
            serde_json::json!({ "supported": true })
        );
        assert_eq!(
            parse_soul_stop_probe(b"", b"").unwrap_err().code,
            "soul-stop-failed"
        );
    }
}

/// Pause all / Resume (#122, Lovable `togglePause`), with agent-bot's
/// `soul pause|resume <agentId> --json` (agent-bot-identity #478): pause
/// cancels the soul's running turn and holds its wakes, launches and chat
/// until resume. Pause answers `{agentId, paused: true, stopped}`, resume
/// `{agentId, paused: false}`. Not owner-gated by Touch ID. An older bundle
/// without the commands answers with its `soul` usage line, which maps to
/// `soul-pause-unsupported`.
#[tauri::command]
pub async fn soul_pause<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
) -> Result<Value, BridgeError> {
    soul_pause_action(app, PauseAction::Pause, &agent).await
}

/// Lifts `soul_pause`; see there.
#[tauri::command]
pub async fn soul_resume<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
) -> Result<Value, BridgeError> {
    soul_pause_action(app, PauseAction::Resume, &agent).await
}

/// Whether the bundled agent-bot has `soul pause`: `{supported}`. Runs the
/// command with no soul, which pauses nothing: a bundle that has it answers
/// with its own `soul pause` usage, an older one with the `soul` usage line.
#[tauri::command]
pub async fn soul_pause_probe<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = vec!["soul".into(), "pause".into(), "--json".into()];
    let output = run_agent_bot(&app, args, "soul-pause-unavailable").await?;
    parse_soul_pause_probe(&output.stdout, &output.stderr)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PauseAction {
    Pause,
    Resume,
}

impl PauseAction {
    fn verb(self) -> &'static str {
        match self {
            Self::Pause => "pause",
            Self::Resume => "resume",
        }
    }

    fn failed(self) -> &'static str {
        match self {
            Self::Pause => "soul-pause-failed",
            Self::Resume => "soul-resume-failed",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Pause => "agent-bot soul pause: ",
            Self::Resume => "agent-bot soul resume: ",
        }
    }
}

async fn soul_pause_action<R: Runtime>(
    app: AppHandle<R>,
    action: PauseAction,
    agent: &str,
) -> Result<Value, BridgeError> {
    let args = soul_pause_args(action, agent)?;
    let output = run_agent_bot(&app, args, "soul-pause-unavailable").await?;
    parse_soul_pause(action, &output.stdout, &output.stderr)
}

fn soul_pause_args(
    action: PauseAction,
    agent: &str,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.is_empty() || agent.starts_with('-') {
        return Err(BridgeError::new(
            "soul-pause-invalid",
            "agent must be an agent id",
        ));
    }
    Ok(vec![
        "soul".into(),
        action.verb().into(),
        agent.into(),
        "--json".into(),
    ])
}

/// True when stderr is an older agent-bot's `soul` usage line, which does
/// not list `soul pause`.
fn soul_pause_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    let message = last_line(stderr);
    serde_json::from_str::<Value>(&last_line(stdout)).is_err()
        && message.contains("usage: agent-bot soul ")
        && !message.contains("soul pause")
}

fn parse_soul_pause(
    action: PauseAction,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<Value, BridgeError> {
    if soul_pause_missing(stdout, stderr) {
        return Err(BridgeError::new(
            "soul-pause-unsupported",
            "this agent-bot has no soul pause",
        ));
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        action.failed(),
        action.prefix(),
        "agent-bot gave no pause result",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && value.get("paused").and_then(Value::as_bool).is_some()
        },
    )
}

fn parse_soul_pause_probe(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_pause_missing(stdout, stderr) {
        return Ok(serde_json::json!({ "supported": false }));
    }
    match parse_soul_pause(PauseAction::Pause, stdout, stderr) {
        Err(error) if error.message.starts_with("usage: agent-bot soul pause") => {
            Ok(serde_json::json!({ "supported": true }))
        }
        Err(error) => Err(error),
        Ok(_) => Err(BridgeError::new(
            "soul-pause-failed",
            "agent-bot paused a soul it was not asked to",
        )),
    }
}

#[cfg(test)]
mod soul_pause_tests {
    use super::*;

    const OLD_USAGE: &[u8] =
        b"agent-bot: usage: agent-bot soul cold-wake <agentId> [on|off|show] | soul stop <agentId|name> [--json] | soul comms <agentId|name> [show|on|off] [--json]\n";

    #[test]
    fn builds_soul_pause_and_resume_arguments() {
        assert_eq!(
            soul_pause_args(PauseAction::Pause, "agent_1").unwrap(),
            vec!["soul", "pause", "agent_1", "--json"]
        );
        assert_eq!(
            soul_pause_args(PauseAction::Resume, "agent_1").unwrap(),
            vec!["soul", "resume", "agent_1", "--json"]
        );
        for agent in ["", "--json", "-x"] {
            assert_eq!(
                soul_pause_args(PauseAction::Pause, agent).unwrap_err().code,
                "soul-pause-invalid"
            );
        }
    }

    #[test]
    fn parses_pause_and_resume_results_or_their_error() {
        let paused = parse_soul_pause(
            PauseAction::Pause,
            b"{\"agentId\":\"agent_1\",\"paused\":true,\"stopped\":false}\n",
            b"",
        )
        .unwrap();
        assert_eq!(paused["paused"], true);
        assert_eq!(paused["stopped"], false);
        let resumed = parse_soul_pause(
            PauseAction::Resume,
            b"{\"agentId\":\"agent_1\",\"paused\":false}\n",
            b"",
        )
        .unwrap();
        assert_eq!(resumed["paused"], false);
        assert_eq!(
            parse_soul_pause(
                PauseAction::Pause,
                b"{\"error\":{\"code\":\"not-owner\",\"message\":\"soul pause is the owner's\"}}\n",
                b"agent-bot soul pause: soul pause is the owner's\n"
            ),
            Err(BridgeError::new("not-owner", "soul pause is the owner's"))
        );
        assert_eq!(
            parse_soul_pause(
                PauseAction::Resume,
                b"",
                b"agent-bot soul resume: no population record for agent_9\n"
            ),
            Err(BridgeError::new(
                "soul-resume-failed",
                "no population record for agent_9"
            ))
        );
        assert_eq!(
            parse_soul_pause(PauseAction::Pause, b"{\"agentId\":\"agent_1\"}\n", b"").unwrap_err(),
            BridgeError::new("soul-pause-failed", "agent-bot gave no pause result")
        );
    }

    #[test]
    fn an_older_bundle_is_unsupported_not_failed() {
        assert_eq!(
            parse_soul_pause(PauseAction::Resume, b"", OLD_USAGE)
                .unwrap_err()
                .code,
            "soul-pause-unsupported"
        );
        assert_eq!(
            parse_soul_pause_probe(b"", OLD_USAGE).unwrap(),
            serde_json::json!({ "supported": false })
        );
    }

    #[test]
    fn probes_a_bundle_with_soul_pause() {
        assert_eq!(
            parse_soul_pause_probe(
                b"{\"error\":{\"code\":\"soul-pause-failed\",\"message\":\"usage: agent-bot soul pause <agentId|name> [--json]\"}}\n",
                b"agent-bot soul pause: usage: agent-bot soul pause <agentId|name> [--json]\n"
            )
            .unwrap(),
            serde_json::json!({ "supported": true })
        );
        assert_eq!(
            parse_soul_pause_probe(b"", b"").unwrap_err().code,
            "soul-pause-failed"
        );
    }
}

/// A soul's model (#128), from agent-bot's `soul model <agentId> show
/// --json`: `{agentId, model, available, listedAt, harness}`. `model` is the
/// owner's choice or null for the harness default; `available` is the
/// harness's own list, cached by the daemon after the soul's first turn.
/// `set` and `clear` are owner-gated by agent-bot (its consent dialog,
/// Touch ID); GeniusBar never asks itself. The daemon applies the model on
/// the soul's next turn.
#[tauri::command]
pub async fn soul_model<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    action: String,
    model: Option<String>,
) -> Result<Value, BridgeError> {
    let args = soul_model_args(&agent, &action, model.as_deref())?;
    let output = run_agent_bot(&app, args, "soul-model-unavailable").await?;
    parse_soul_model(&output.stdout, &output.stderr)
}

/// The longest model id agent-bot accepts.
const MAX_MODEL: usize = 120;

fn soul_model_args(
    agent: &str,
    action: &str,
    model: Option<&str>,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    let invalid = |message: &str| BridgeError::new("soul-model-invalid", message);
    if agent.is_empty() || agent.starts_with('-') {
        return Err(invalid("agent must be an agent id"));
    }
    let mut args: Vec<std::ffi::OsString> = vec!["soul".into(), "model".into(), agent.into()];
    match action {
        "show" | "clear" => args.push(action.into()),
        "set" => {
            let model = model.unwrap_or("");
            if model.trim().is_empty()
                || model.starts_with('-')
                || model.chars().count() > MAX_MODEL
                || model.chars().any(char::is_control)
            {
                return Err(invalid("model must be printable text up to 120 characters"));
            }
            args.push("set".into());
            args.push(model.into());
        }
        _ => return Err(invalid("action must be show, set or clear")),
    }
    args.push("--json".into());
    Ok(args)
}

fn parse_soul_model(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-model-failed",
        "agent-bot soul model: ",
        "agent-bot gave no model setting",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && matches!(value.get("model"), Some(Value::Null | Value::String(_)))
                && matches!(value.get("available"), Some(Value::Null | Value::Array(_)))
        },
    )
}

#[cfg(test)]
mod soul_model_tests {
    use super::*;

    #[test]
    fn builds_soul_model_arguments() {
        assert_eq!(
            soul_model_args("agent_1", "show", None).unwrap(),
            vec!["soul", "model", "agent_1", "show", "--json"]
        );
        assert_eq!(
            soul_model_args("agent_1", "clear", Some("ignored")).unwrap(),
            vec!["soul", "model", "agent_1", "clear", "--json"]
        );
        assert_eq!(
            soul_model_args("agent_1", "set", Some("claude-opus-4-1")).unwrap(),
            vec![
                "soul",
                "model",
                "agent_1",
                "set",
                "claude-opus-4-1",
                "--json"
            ]
        );
        let long = "m".repeat(121);
        for (agent, action, model) in [
            ("agent_1", "set", None),
            ("agent_1", "set", Some("")),
            ("agent_1", "set", Some("  ")),
            ("agent_1", "set", Some("--json")),
            ("agent_1", "set", Some("a\nb")),
            ("agent_1", "set", Some(long.as_str())),
            ("agent_1", "reset", None),
            ("", "show", None),
            ("--json", "show", None),
        ] {
            assert_eq!(
                soul_model_args(agent, action, model).unwrap_err().code,
                "soul-model-invalid"
            );
        }
        assert!(soul_model_args("agent_1", "set", Some(&"m".repeat(120))).is_ok());
    }

    #[test]
    fn parses_soul_models_or_their_error() {
        let shown = parse_soul_model(
            b"{\"agentId\":\"agent_1\",\"model\":null,\"available\":null,\"listedAt\":null,\"harness\":\"claude\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(shown["model"], Value::Null);
        let set = parse_soul_model(
            b"{\"agentId\":\"agent_1\",\"model\":\"opus\",\"available\":[{\"modelId\":\"opus\",\"name\":\"Opus\"}],\"listedAt\":\"2026-10-05T00:00:00.000Z\",\"harness\":\"claude\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(set["available"][0]["name"], "Opus");
        assert_eq!(
            parse_soul_model(
                b"{\"error\":{\"code\":\"soul-model-failed\",\"message\":\"the owner did not approve\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "soul-model-failed",
                "the owner did not approve"
            ))
        );
        assert_eq!(
            parse_soul_model(
                b"",
                b"agent-bot soul model: soul model settings could not be read\n"
            ),
            Err(BridgeError::new(
                "soul-model-failed",
                "soul model settings could not be read"
            ))
        );
        // An older agent-bot without `soul model` prints usage or nothing.
        assert_eq!(
            parse_soul_model(b"{\"agentId\":\"agent_1\"}\n", b"").unwrap_err(),
            BridgeError::new("soul-model-failed", "agent-bot gave no model setting")
        );
        assert_eq!(
            parse_soul_model(b"", b"").unwrap_err().message,
            "agent-bot gave no model setting"
        );
    }
}

/// Archives a soul (GeniusBar #94), from agent-bot's `soul remove <agentId>
/// [--scope soul|team] --json`: `{agentId, name, handle, wake, comms,
/// retired, archived}`, followed (agent-bot-identity #625, GeniusBar #283)
/// by `plan` and `effects {scope, archived[], independent[], notArchived[]}`.
/// Nothing is deleted: the soul stops waking, leaves agent-comms, is retired
/// and its folder moves to the souls folder's `.archive`. agent-bot refuses
/// while the soul runs (`soul-running`) and owner-gates the rest (its
/// consent dialog, Touch ID); GeniusBar never asks itself. `scope` is
/// passed on only when given, so an older engine sees the call it knows.
#[tauri::command]
pub async fn soul_remove<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    scope: Option<String>,
) -> Result<Value, BridgeError> {
    let args = soul_remove_args(&agent, scope.as_deref(), false)?;
    let output = run_agent_bot(&app, args, "soul-remove-unavailable").await?;
    parse_soul_remove(&output.stdout, &output.stderr)
}

/// The exact souls a remove would touch (GeniusBar #283), from agent-bot's
/// `soul remove <agentId> --plan [--scope soul|team] --json`: `{schemaVersion
/// 1, scope, agentId, capabilities {plan, team, independent, restore,
/// delete}, archived[], independent[], unchanged[]}`, each entry `{agentId,
/// name, displayName, status, harness, parentId, running, depth}`. Read-only:
/// no owner gate, nothing changes. Null when the bundled engine has no
/// `--plan` (before agent-bot-identity #625: it answers its usage line, and
/// changes nothing either); the UI then shows only what it knows and never
/// infers the team's fate itself.
#[tauri::command]
pub async fn soul_remove_plan<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    scope: Option<String>,
) -> Result<Value, BridgeError> {
    let args = soul_remove_args(&agent, scope.as_deref(), true)?;
    let output = run_agent_bot(&app, args, "soul-remove-unavailable").await?;
    parse_soul_remove_plan(&output.stdout, &output.stderr)
}

fn soul_remove_args(
    agent: &str,
    scope: Option<&str>,
    plan: bool,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.trim().is_empty() || agent.starts_with('-') || agent.chars().any(char::is_control) {
        return Err(BridgeError::new(
            "soul-remove-invalid",
            "agent must be an agent id",
        ));
    }
    if scope.is_some_and(|s| s != "soul" && s != "team") {
        return Err(BridgeError::new(
            "soul-remove-invalid",
            "scope must be soul or team",
        ));
    }
    let mut args: Vec<std::ffi::OsString> = vec!["soul".into(), "remove".into(), agent.into()];
    if plan {
        args.push("--plan".into());
    }
    if let Some(scope) = scope {
        args.push("--scope".into());
        args.push(scope.into());
    }
    args.push("--json".into());
    Ok(args)
}

/// True when the engine answered a usage line that does not know `--plan`:
/// agent-bot before #625 takes `--plan` for a stray argument and prints its
/// `soul remove` usage (as a JSON error with `--json`), and an older one
/// still prints the `soul` usage line on stderr. A usage line naming
/// `--plan` is a real mistake and stays an error.
fn soul_remove_plan_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    let unaware =
        |message: &str| message.contains("usage: agent-bot soul") && !message.contains("--plan");
    match serde_json::from_str::<Value>(&last_line(stdout)) {
        Ok(value) => value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .is_some_and(unaware),
        Err(_) => unaware(&last_line(stderr)),
    }
}

fn parse_soul_remove_plan(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_remove_plan_missing(stdout, stderr) {
        return Ok(Value::Null);
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-remove-plan-failed",
        "agent-bot soul remove: ",
        "agent-bot gave no removal plan",
        |value| {
            value.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                && value.get("agentId").and_then(Value::as_str).is_some()
                && value.get("archived").is_some_and(Value::is_array)
        },
    )
}

fn parse_soul_remove(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-remove-failed",
        "agent-bot soul remove: ",
        "agent-bot did not archive the companion",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && value.get("retired").and_then(Value::as_bool) == Some(true)
        },
    )
}

/// The daemon's status (#122 computer-use badge), from agent-bot's `daemon
/// status --json`: `{running, computerUse: [{agentId, since}], ...}`. Null
/// when agent-bot cannot answer (an older bundle, a failed run), so the
/// desktop simply shows no badge.
#[tauri::command]
pub async fn daemon_status<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = vec!["daemon".into(), "status".into(), "--json".into()];
    match run_agent_bot(&app, args, "daemon-status-unavailable").await {
        Ok(output) => Ok(parse_daemon_status(&output.stdout)),
        Err(_) => Ok(Value::Null),
    }
}

pub(crate) fn parse_daemon_status(stdout: &[u8]) -> Value {
    match serde_json::from_str::<Value>(&last_line(stdout)) {
        Ok(value) if value.get("running").and_then(Value::as_bool).is_some() => value,
        _ => Value::Null,
    }
}

#[cfg(test)]
mod soul_remove_tests {
    use super::*;

    #[test]
    fn builds_soul_remove_arguments() {
        assert_eq!(
            soul_remove_args("agent_1", None, false).unwrap(),
            vec!["soul", "remove", "agent_1", "--json"]
        );
        assert_eq!(
            soul_remove_args("agent_1", Some("team"), false).unwrap(),
            vec!["soul", "remove", "agent_1", "--scope", "team", "--json"]
        );
        assert_eq!(
            soul_remove_args("agent_1", None, true).unwrap(),
            vec!["soul", "remove", "agent_1", "--plan", "--json"]
        );
        assert_eq!(
            soul_remove_args("agent_1", Some("soul"), true).unwrap(),
            vec!["soul", "remove", "agent_1", "--plan", "--scope", "soul", "--json"]
        );
        for agent in ["", "  ", "--json", "-x", "a\nb"] {
            assert_eq!(
                soul_remove_args(agent, None, false).unwrap_err().code,
                "soul-remove-invalid"
            );
        }
        for scope in ["", "fleet", "--plan"] {
            assert_eq!(
                soul_remove_args("agent_1", Some(scope), true)
                    .unwrap_err()
                    .message,
                "scope must be soul or team"
            );
        }
    }

    /// agent-bot-identity #625's `soul remove luna --plan --scope team --json`
    /// for a lead with a nested, offline descendant.
    const PLAN: &[u8] = br#"{"schemaVersion":1,"scope":"team","agentId":"agent_p","capabilities":{"plan":true,"team":true,"independent":true,"restore":false,"delete":false},"archived":[{"agentId":"agent_p","name":"luna","displayName":"luna","status":"active","harness":"codex","parentId":null,"running":false,"depth":0},{"agentId":"agent_c","name":"ember","displayName":"ember","status":"active","harness":null,"parentId":"agent_p","running":false,"depth":1},{"agentId":"agent_s","name":"sprocket","displayName":"Sprocket","status":"active","harness":null,"parentId":"agent_c","running":null,"depth":2}],"independent":[],"unchanged":[]}
"#;

    #[test]
    fn parses_removal_plans_and_nulls_an_engine_without_them() {
        let plan = parse_soul_remove_plan(PLAN, b"").unwrap();
        assert_eq!(plan["archived"][2]["displayName"], "Sprocket");
        assert_eq!(plan["capabilities"]["restore"], false);
        // agent-bot 0.10.51 takes `--plan` for a stray argument: its usage
        // line, as a JSON error, before any owner gate.
        assert_eq!(
            parse_soul_remove_plan(
                b"{\"error\":{\"code\":\"soul-remove-failed\",\"message\":\"usage: agent-bot soul remove <agentId|name> [--json] [--principal-stdin]\"}}\n",
                b"agent-bot soul remove: usage: agent-bot soul remove <agentId|name> [--json] [--principal-stdin]\n"
            )
            .unwrap(),
            Value::Null
        );
        // An even older one prints the `soul` usage line, without JSON.
        assert_eq!(
            parse_soul_remove_plan(
                b"",
                b"agent-bot: usage: agent-bot soul cold-wake <agentId> [on|off|show] | soul remove <agentId|name> [--json]\n"
            )
            .unwrap(),
            Value::Null
        );
        // An engine that knows `--plan` and still prints usage made a real complaint.
        assert_eq!(
            parse_soul_remove_plan(
                b"{\"error\":{\"code\":\"soul-remove-failed\",\"message\":\"--scope must be one of soul, team\\nusage: agent-bot soul remove <agentId|name> [--scope soul|team] [--plan] [--json] [--principal-stdin]\"}}\n",
                b""
            )
            .unwrap_err()
            .code,
            "soul-remove-failed"
        );
        assert_eq!(
            parse_soul_remove_plan(
                b"{\"error\":{\"code\":\"soul-remove-failed\",\"message\":\"no population record for agent_x\"}}\n",
                b"agent-bot soul remove: no population record for agent_x\n"
            ),
            Err(BridgeError::new(
                "soul-remove-failed",
                "no population record for agent_x"
            ))
        );
        assert_eq!(
            parse_soul_remove_plan(b"{\"agentId\":\"agent_1\"}\n", b"").unwrap_err(),
            BridgeError::new("soul-remove-plan-failed", "agent-bot gave no removal plan")
        );
    }

    #[test]
    fn parses_removed_souls_or_their_error() {
        let removed = parse_soul_remove(
            b"{\"agentId\":\"agent_1\",\"name\":\"luna\",\"handle\":\"luna\",\"wake\":\"off\",\"comms\":\"left\",\"retired\":true,\"archived\":[{\"from\":\"/a\",\"to\":\"/b\"}]}\n",
            b"",
        )
        .unwrap();
        assert_eq!(removed["archived"][0]["to"], "/b");
        assert_eq!(
            parse_soul_remove(
                b"{\"error\":{\"code\":\"soul-running\",\"message\":\"agent_1 is running; stop it before removing it\"}}\n",
                b"agent-bot soul remove: agent_1 is running; stop it before removing it\n"
            ),
            Err(BridgeError::new(
                "soul-running",
                "agent_1 is running; stop it before removing it"
            ))
        );
        assert_eq!(
            parse_soul_remove(b"", b"agent-bot soul remove: the owner did not approve\n"),
            Err(BridgeError::new(
                "soul-remove-failed",
                "the owner did not approve"
            ))
        );
        // An older agent-bot without `soul remove`.
        assert_eq!(
            parse_soul_remove(b"{\"agentId\":\"agent_1\"}\n", b"").unwrap_err(),
            BridgeError::new(
                "soul-remove-failed",
                "agent-bot did not archive the companion"
            )
        );
    }

    #[test]
    fn parses_daemon_status_or_null() {
        let status = parse_daemon_status(
            b"{\"running\":true,\"computerUse\":[{\"agentId\":\"agent_1\",\"since\":\"2026-10-05T00:00:00.000Z\"}]}\n",
        );
        assert_eq!(status["computerUse"][0]["agentId"], "agent_1");
        assert_eq!(
            parse_daemon_status(b"{\"running\":false,\"computerUse\":[]}\n")["running"],
            false
        );
        assert_eq!(parse_daemon_status(b""), Value::Null);
        assert_eq!(parse_daemon_status(b"usage: agent-bot ...\n"), Value::Null);
    }
}

/// Whether GeniusBar's login services are registered (#118): their
/// LaunchAgent plists exist. A plain file check, with no Node or agent-bot
/// run, so it answers at once even while a busy Mac is still starting the
/// services; the popup then says "starting" instead of offering setup.
#[tauri::command]
pub fn services_installed<R: Runtime>(app: AppHandle<R>) -> Value {
    match app.path().home_dir() {
        Ok(home) => services_installed_in(&home.join("Library").join("LaunchAgents")),
        Err(_) => json!({ "broker": false, "daemon": false }),
    }
}

fn services_installed_in(agents: &std::path::Path) -> Value {
    let label = |name: &str| {
        HOST_ENV
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| *value)
            .unwrap_or_default()
    };
    let installed = |name: &str| agents.join(format!("{}.plist", label(name))).is_file();
    json!({
        "broker": installed("AGENT_COMMS_SERVICE_LABEL"),
        "daemon": installed("AGENT_BOT_SERVICE_LABEL"),
    })
}

#[cfg(test)]
mod services_installed_tests {
    use super::*;

    #[test]
    fn reports_which_service_plists_exist() {
        let agents =
            std::env::temp_dir().join(format!("gb-services-installed-{}", std::process::id()));
        std::fs::create_dir_all(&agents).unwrap();
        assert_eq!(
            services_installed_in(&agents),
            json!({ "broker": false, "daemon": false })
        );
        std::fs::write(agents.join("app.geniusbar.broker.plist"), "<plist/>").unwrap();
        assert_eq!(
            services_installed_in(&agents),
            json!({ "broker": true, "daemon": false })
        );
        std::fs::write(agents.join("app.geniusbar.agent-bot.plist"), "<plist/>").unwrap();
        assert_eq!(
            services_installed_in(&agents),
            json!({ "broker": true, "daemon": true })
        );
        std::fs::remove_dir_all(&agents).unwrap();
        assert_eq!(
            services_installed_in(&agents),
            json!({ "broker": false, "daemon": false })
        );
    }
}

/// Every soul's agent-comms and managed state in one agent-bot run (#137),
/// from `population list --json` (agent-bot 0.10.15+: a pretty-printed array
/// of census records). The desktop's comms badges read this once a minute
/// instead of one `soul comms show` per soul. Only `agentId`, `status`,
/// `managed` and `comms` come back, so paths and transcript locators never
/// reach the web view.
#[tauri::command]
pub async fn population_list<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = population_list_args().into_iter().map(Into::into).collect();
    let output = run_agent_bot(&app, args, "population-unavailable").await?;
    parse_population_list(&output.stdout, &output.stderr)
}

fn population_list_args() -> Vec<&'static str> {
    vec!["population", "list", "--json"]
}

fn parse_population_list(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if let Ok(Value::Array(records)) = serde_json::from_slice::<Value>(stdout) {
        let souls: Vec<Value> = records
            .iter()
            .filter_map(|record| {
                let id = record.get("id").and_then(Value::as_str)?;
                let field = |name: &str| record.get(name).cloned().unwrap_or(Value::Null);
                Some(json!({
                    "agentId": id,
                    "status": field("status"),
                    "managed": field("managed"),
                    "comms": field("comms"),
                    "paused": field("paused"),
                    "computerUse": field("computerUse"),
                    "appearance": field("appearance"),
                    "role": field("role"),
                    "roleLine": field("roleLine"),
                }))
            })
            .collect();
        return Ok(Value::Array(souls));
    }
    let message = last_line(stderr);
    let message = message
        .strip_prefix("agent-population: ")
        .unwrap_or(&message);
    Err(BridgeError::new(
        "population-failed",
        if message.is_empty() {
            "agent-bot gave no census list"
        } else {
            message
        },
    ))
}

#[cfg(test)]
mod population_list_tests {
    use super::*;

    #[test]
    fn builds_population_list_arguments() {
        assert_eq!(population_list_args(), vec!["population", "list", "--json"]);
    }

    #[test]
    fn keeps_only_the_badge_fields_of_each_census_record() {
        let list = parse_population_list(
            br#"[
  {
    "id": "agent_1",
    "name": "luna",
    "displayName": "Luna",
    "status": "active",
    "spacePath": "/Users/x/.agent-space",
    "transcriptLocator": {"provider": "claude", "id": "t1"},
    "managed": true,
    "comms": true,
    "paused": true,
    "computerUse": false,
    "mode": "safe",
    "model": null,
    "parentId": null
  },
  {"id": "agent_2", "status": "retired", "managed": false, "comms": false},
  {"name": "no id"}
]
"#,
            b"",
        )
        .unwrap();
        let souls = list.as_array().unwrap();
        assert_eq!(souls.len(), 2);
        assert_eq!(souls[0]["agentId"], "agent_1");
        assert_eq!(souls[0]["comms"], true);
        assert_eq!(souls[0]["managed"], true);
        assert!(souls[0].get("spacePath").is_none());
        assert!(souls[0].get("transcriptLocator").is_none());
        assert_eq!(souls[1]["comms"], false);
        assert_eq!(souls[1]["status"], "retired");
        // `paused` (agent-bot-identity #478) is carried; an older record has none.
        assert_eq!(souls[0]["paused"], true);
        assert_eq!(souls[1]["paused"], Value::Null);
        // `computerUse` (agent-bot-identity #482) likewise.
        assert_eq!(souls[0]["computerUse"], false);
        assert_eq!(souls[1]["computerUse"], Value::Null);
        assert_eq!(parse_population_list(b"[]\n", b"").unwrap(), json!([]));
    }

    #[test]
    fn carries_the_role_and_appearance_of_each_census_record() {
        let list = parse_population_list(
            br#"[
  {"id": "agent_1", "comms": true, "role": "Release captain", "roleLine": "Release captain",
   "appearance": {"hue": 210}},
  {"id": "agent_2", "comms": false, "role": null, "roleLine": "Lead, 2 subagents"},
  {"id": "agent_3", "comms": false}
]
"#,
            b"",
        )
        .unwrap();
        let souls = list.as_array().unwrap();
        assert_eq!(souls[0]["role"], "Release captain");
        assert_eq!(souls[0]["roleLine"], "Release captain");
        assert_eq!(souls[0]["appearance"], json!({"hue": 210}));
        assert_eq!(souls[1]["role"], Value::Null);
        assert_eq!(souls[1]["roleLine"], "Lead, 2 subagents");
        // An older agent-bot sends none of them.
        assert_eq!(souls[2]["role"], Value::Null);
        assert_eq!(souls[2]["roleLine"], Value::Null);
        assert_eq!(souls[2]["appearance"], Value::Null);
    }

    #[test]
    fn reports_a_failed_or_unreadable_list() {
        assert_eq!(
            parse_population_list(b"", b"agent-population: population store is unreadable\n"),
            Err(BridgeError::new(
                "population-failed",
                "population store is unreadable"
            ))
        );
        // Not an array (an older agent-bot printing the text table).
        assert_eq!(
            parse_population_list(b"NAME\tID\tAPP\n", b""),
            Err(BridgeError::new(
                "population-failed",
                "agent-bot gave no census list"
            ))
        );
    }
}

/// The soul templates the launch form offers (#65, Lovable launch dialog
/// "1 · Soul"), from agent-bot's `soul templates --json`
/// (agent-bot-identity #374): `{templates: [{name, description,
/// preferredHarnesses, defaultHarness, package, revision, source}],
/// soulsRoot, errors: [{package, message}]}`, sorted by name. agent-bot
/// reads local packages only and exits 0 with unreadable packages listed in
/// `errors`. An older bundle without the command answers with its `soul`
/// usage line, which maps to `soul-templates-unsupported`, and the form
/// keeps its package path field alone.
#[tauri::command]
pub async fn list_soul_templates<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let args = vec!["soul".into(), "templates".into(), "--json".into()];
    let output = run_agent_bot(&app, args, "soul-templates-unavailable").await?;
    parse_soul_templates(&output.stdout, &output.stderr)
}

/// True when stderr is an older agent-bot's `soul` usage line, which does
/// not list `soul templates`.
fn soul_templates_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    let message = last_line(stderr);
    serde_json::from_str::<Value>(&last_line(stdout)).is_err()
        && message.contains("usage: agent-bot soul ")
        && !message.contains("soul templates")
}

fn parse_soul_templates(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_templates_missing(stdout, stderr) {
        return Err(BridgeError::new(
            "soul-templates-unsupported",
            "this agent-bot has no soul templates",
        ));
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-templates-failed",
        "agent-bot soul templates: ",
        "agent-bot gave no soul templates",
        |value| value.get("templates").and_then(Value::as_array).is_some(),
    )
}

#[cfg(test)]
mod soul_templates_tests {
    use super::*;

    /// agent-bot 0.10.21's `soul` usage line: it has `soul spawn` and
    /// `soul locate`, but no `soul templates`.
    const OLD_USAGE: &[u8] =
        b"agent-bot: usage: agent-bot soul cold-wake <agentId> [on|off|show] | soul pause|resume <agentId|name> [--json] | soul dir AGENT_ID | soul locate PATH | soul spawn TEMPLATE_PATH --name NAME [--harness H] | soul confinement AGENT_ID off|warn|deny\n";

    #[test]
    fn parses_the_template_listing() {
        let listed = parse_soul_templates(
            b"{\"templates\":[{\"name\":\"Starter\",\"description\":\"A first companion.\",\"preferredHarnesses\":[\"claude\"],\"defaultHarness\":\"claude\",\"package\":\"/Users/u/Souls/Starter.soul\",\"revision\":null,\"source\":\"bundled\"}],\"soulsRoot\":\"/Users/u/Souls\",\"errors\":[{\"package\":\"/Users/u/Souls/Bad.soul\",\"message\":\"soul.json is missing\"}]}\n",
            b"",
        )
        .unwrap();
        assert_eq!(listed["templates"][0]["name"], "Starter");
        assert_eq!(
            listed["templates"][0]["package"],
            "/Users/u/Souls/Starter.soul"
        );
        assert_eq!(listed["errors"][0]["message"], "soul.json is missing");
        let empty = parse_soul_templates(
            b"{\"templates\":[],\"soulsRoot\":\"/r\",\"errors\":[]}\n",
            b"",
        )
        .unwrap();
        assert_eq!(empty["templates"], json!([]));
    }

    #[test]
    fn reports_a_failed_listing() {
        assert_eq!(
            parse_soul_templates(
                b"",
                b"agent-bot soul templates: EACCES: permission denied\n"
            ),
            Err(BridgeError::new(
                "soul-templates-failed",
                "EACCES: permission denied"
            ))
        );
        assert_eq!(
            parse_soul_templates(b"{\"soulsRoot\":\"/r\"}\n", b"").unwrap_err(),
            BridgeError::new("soul-templates-failed", "agent-bot gave no soul templates")
        );
        assert_eq!(
            parse_soul_templates(b"", b"").unwrap_err().message,
            "agent-bot gave no soul templates"
        );
    }

    #[test]
    fn an_older_bundle_is_unsupported_not_failed() {
        assert_eq!(
            parse_soul_templates(b"", OLD_USAGE).unwrap_err(),
            BridgeError::new(
                "soul-templates-unsupported",
                "this agent-bot has no soul templates"
            )
        );
        // A bundle that has the command but refuses its arguments still has it.
        assert_eq!(
            parse_soul_templates(
                b"",
                b"agent-bot soul templates: usage: agent-bot soul templates [--json]\n"
            )
            .unwrap_err()
            .code,
            "soul-templates-failed"
        );
    }
}

/// A soul's read-only profile for the Customize dialog (#64), from
/// agent-bot's `soul profile <agentId> --json` (agent-bot-identity #375):
/// `{agentId, profile: {...}, files, skills, credentials, sop: {resolved,
/// override}, errors}`. Credentials carry names and status, never values.
/// An unknown soul answers `{error: {code: "soul-not-found"}}`. An older
/// bundle without the command answers with its `soul` usage line, which
/// maps to `soul-profile-unsupported`, and the dialog stays hidden.
#[tauri::command]
pub async fn soul_profile<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
) -> Result<Value, BridgeError> {
    let agent = profile_argument(agent, "agent")?;
    let args = vec![
        "soul".into(),
        "profile".into(),
        agent.into(),
        "--json".into(),
    ];
    let output = run_agent_bot(&app, args, "soul-profile-unavailable").await?;
    parse_soul_profile(&output.stdout, &output.stderr)
}

/// One file of a soul's profile (#64), from `soul profile <agentId> --file
/// RELATIVE_PATH --json`: `{agentId, path, size, contents}`. agent-bot
/// accepts only an exact inventory path of a text file up to 256 KiB
/// (`soul-profile-file-denied`, `soul-profile-file-too-large`).
#[tauri::command]
pub async fn soul_profile_file<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
    path: String,
) -> Result<Value, BridgeError> {
    let agent = profile_argument(agent, "agent")?;
    let path = profile_argument(path, "path")?;
    let args = vec![
        "soul".into(),
        "profile".into(),
        agent.into(),
        "--file".into(),
        path.into(),
        "--json".into(),
    ];
    let output = run_agent_bot(&app, args, "soul-profile-unavailable").await?;
    parse_soul_profile_file(&output.stdout, &output.stderr)
}

/// A non-empty argument that agent-bot cannot read as a flag.
fn profile_argument(value: String, what: &str) -> Result<String, BridgeError> {
    soul_argument(value, what, "soul-profile-failed")
}

/// A non-empty soul argument that agent-bot cannot read as a flag, refused
/// with the command's own `failed` code.
fn soul_argument(value: String, what: &str, failed: &str) -> Result<String, BridgeError> {
    if value.trim().is_empty() || value.starts_with('-') {
        return Err(BridgeError::new(
            failed,
            &format!("not a soul {what}: {value}"),
        ));
    }
    Ok(value)
}

/// True when stderr is an older agent-bot's `soul` usage line, which does
/// not list `soul profile`.
fn soul_profile_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    let message = last_line(stderr);
    serde_json::from_str::<Value>(&last_line(stdout)).is_err()
        && message.contains("usage: agent-bot soul ")
        && !message.contains("soul profile")
}

fn soul_profile_unsupported() -> BridgeError {
    BridgeError::new(
        "soul-profile-unsupported",
        "this agent-bot has no soul profile",
    )
}

fn parse_soul_profile(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_profile_missing(stdout, stderr) {
        return Err(soul_profile_unsupported());
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-profile-failed",
        "agent-bot soul profile: ",
        "agent-bot gave no soul profile",
        |value| {
            value.get("agentId").and_then(Value::as_str).is_some()
                && value.get("profile").is_some_and(Value::is_object)
        },
    )
}

fn parse_soul_profile_file(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_profile_missing(stdout, stderr) {
        return Err(soul_profile_unsupported());
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-profile-failed",
        "agent-bot soul profile: ",
        "agent-bot gave no file contents",
        |value| {
            value.get("path").and_then(Value::as_str).is_some()
                && value.get("contents").and_then(Value::as_str).is_some()
        },
    )
}

#[cfg(test)]
mod soul_profile_tests {
    use super::*;

    /// agent-bot 0.10.22's `soul` usage line: it has `soul templates`, but
    /// no `soul profile`.
    const OLD_USAGE: &[u8] =
        b"agent-bot: usage: agent-bot soul cold-wake <agentId> [on|off|show] | soul show <agentId|name> [--json] | soul asides <agentId|name> [--after ASIDE_ID] [--json] | soul dir AGENT_ID | soul locate PATH | soul templates [--json] | soul spawn TEMPLATE_PATH --name NAME [--harness H]\n";

    #[test]
    fn parses_the_profile() {
        let profile = parse_soul_profile(
            b"{\"agentId\":\"agent_p\",\"profile\":{\"name\":\"luna\",\"displayName\":\"Luna\",\"description\":\"Leads.\",\"harness\":\"claude\",\"package\":\"/s/Luna.soul\",\"revision\":\"r1\",\"template\":false,\"parentId\":null,\"status\":\"active\"},\"files\":[{\"path\":\"soul.md\",\"kind\":\"soul\",\"size\":12,\"modifiedAt\":\"2026-10-01T00:00:00.000Z\",\"text\":true}],\"skills\":[{\"name\":\"review\",\"source\":\"sop\",\"path\":\"sop/skills/review/SKILL.md\",\"commit\":\"abc123\"}],\"credentials\":[{\"name\":\"luna-app\",\"provider\":\"github\",\"status\":\"declared\"}],\"sop\":{\"resolved\":{\"source\":\"qwts/sop\",\"commit\":\"abc123\"},\"override\":null},\"errors\":[]}\n",
            b"",
        )
        .unwrap();
        assert_eq!(profile["agentId"], "agent_p");
        assert_eq!(profile["profile"]["displayName"], "Luna");
        assert_eq!(profile["files"][0]["path"], "soul.md");
        assert_eq!(profile["credentials"][0]["status"], "declared");
        assert_eq!(profile["sop"]["resolved"]["commit"], "abc123");
    }

    #[test]
    fn parses_a_file() {
        let file = parse_soul_profile_file(
            b"{\"agentId\":\"agent_p\",\"path\":\"soul.md\",\"size\":7,\"contents\":\"# Luna\\n\"}\n",
            b"",
        )
        .unwrap();
        assert_eq!(file["contents"], "# Luna\n");
    }

    #[test]
    fn keeps_agent_bot_error_codes() {
        assert_eq!(
            parse_soul_profile(
                b"{\"error\":{\"code\":\"soul-not-found\",\"message\":\"No soul named nobody.\"}}\n",
                b"",
            )
            .unwrap_err(),
            BridgeError::new("soul-not-found", "No soul named nobody.")
        );
        assert_eq!(
            parse_soul_profile_file(
                b"{\"error\":{\"code\":\"soul-profile-file-too-large\",\"message\":\"Profile file is larger than 262144 bytes.\"}}\n",
                b"",
            )
            .unwrap_err()
            .code,
            "soul-profile-file-too-large"
        );
        assert_eq!(
            parse_soul_profile(b"", b"agent-bot soul profile: EACCES\n").unwrap_err(),
            BridgeError::new("soul-profile-failed", "EACCES")
        );
        assert_eq!(
            parse_soul_profile(b"{\"agentId\":\"agent_p\"}\n", b"")
                .unwrap_err()
                .message,
            "agent-bot gave no soul profile"
        );
    }

    #[test]
    fn an_older_bundle_is_unsupported_not_failed() {
        assert_eq!(
            parse_soul_profile(b"", OLD_USAGE).unwrap_err(),
            soul_profile_unsupported()
        );
        assert_eq!(
            parse_soul_profile_file(b"", OLD_USAGE).unwrap_err().code,
            "soul-profile-unsupported"
        );
        // A bundle that has the command but refuses its arguments still has it.
        assert_eq!(
            parse_soul_profile(
                b"{\"error\":{\"code\":\"soul-profile-failed\",\"message\":\"usage: agent-bot soul profile <agentId|name> [--json] [--file RELATIVE_PATH]\"}}\n",
                OLD_USAGE,
            )
            .unwrap_err()
            .code,
            "soul-profile-failed"
        );
    }

    #[test]
    fn refuses_flag_like_arguments() {
        assert!(profile_argument("--file".into(), "agent").is_err());
        assert!(profile_argument(" ".into(), "path").is_err());
        assert_eq!(
            profile_argument("agent_p".into(), "agent").unwrap(),
            "agent_p"
        );
    }
}

/// A soul's environment descriptor (#268; agent-bot-identity #583,
/// ADR-0583, `docs/soul-environment.md`), from `soul env <agentId> --json`,
/// passed on as the engine printed it. Schema 1: `engine {version,
/// contractVersion, capabilities}`, `identity`, `root {soulDir, soulsRoot,
/// marker, copies, ...}`, `components[]` (every row classified, with its
/// retention), `classification`, `harnesses`, `runtimes`, `providers`,
/// `launch`, `readiness {ready, problems[]}` (each problem names the command
/// that fixes it; nothing here runs one), `migration`, `retention` and
/// `errors[]`. Every key is always present: unknown scalars are null,
/// collections empty. `engine.capabilities` gates each slice the app adopts
/// (`revision-prepare` here; provisioning, migration and export later), so
/// nothing is decided from the version. An older bundle without the command
/// answers its `soul` usage line, which maps to `soul-env-unsupported`.
#[tauri::command]
pub async fn soul_env<R: Runtime>(app: AppHandle<R>, agent: String) -> Result<Value, BridgeError> {
    let agent = soul_argument(agent, "agent", "soul-env-failed")?;
    let output = run_agent_bot(&app, soul_env_args(&agent), "soul-env-unavailable").await?;
    parse_soul_env(&output.stdout, &output.stderr)
}

fn soul_env_args(agent: &str) -> Vec<std::ffi::OsString> {
    vec!["soul".into(), "env".into(), agent.into(), "--json".into()]
}

/// True when stderr is an older agent-bot's `soul` usage line, which does
/// not list `soul env` (before agent-bot 0.10.46).
fn soul_env_missing(stdout: &[u8], stderr: &[u8]) -> bool {
    let message = last_line(stderr);
    serde_json::from_str::<Value>(&last_line(stdout)).is_err()
        && message.contains("usage: agent-bot soul ")
        && !message.contains("soul env")
}

fn parse_soul_env(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if soul_env_missing(stdout, stderr) {
        return Err(BridgeError::new(
            "soul-env-unsupported",
            "this agent-bot has no soul environment",
        ));
    }
    parse_agent_bot_json(
        stdout,
        stderr,
        "soul-env-failed",
        "agent-bot soul env: ",
        "agent-bot gave no soul environment",
        |value| {
            value.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                && value.get("engine").is_some_and(Value::is_object)
                && value.get("components").is_some_and(Value::is_array)
        },
    )
}

/// True when the descriptor's engine lists `capability`.
fn engine_has(descriptor: &Value, capability: &str) -> bool {
    descriptor
        .get("engine")
        .and_then(|engine| engine.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|c| c.as_str() == Some(capability)))
}

/// Whether the bundled engine stages revision edits itself
/// (`revision-prepare`, agent-bot 0.10.46). Asked once per bridge command
/// and never kept: the bundle changes under a running app (an update), and
/// a downgraded one must fall back at once. A bundle without `soul env` at
/// all is one without the capability; any other failure (an unknown soul)
/// is the caller's.
async fn revision_prepare_supported<R: Runtime>(
    app: &AppHandle<R>,
    agent: &str,
) -> Result<bool, BridgeError> {
    let output = run_agent_bot(app, soul_env_args(agent), "soul-revision-unavailable").await?;
    match parse_soul_env(&output.stdout, &output.stderr) {
        Ok(descriptor) => Ok(engine_has(&descriptor, "revision-prepare")),
        Err(error) if error.code == "soul-env-unsupported" => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod soul_env_tests {
    use super::*;

    /// agent-bot 0.10.46's `soul env <id> --json` for a spawned, built soul
    /// whose space is still linked (temp paths shortened).
    const ENV: &str = r#"{"schemaVersion":1,"engine":{"version":"0.10.46","contractVersion":1,"capabilities":["env","revision-prepare"]},"identity":{"agentId":"agent_3db71bf8-733a-8253-a4ff-4a14e66d4ed9","name":"example","displayName":"Example","status":"active","harness":null,"genesis":{"revision":"sha256:4d39dc5f53ae18b0562fe8006ca4d83dc0e003dd8b12147a78dfe37f46e2fd44","parentSoul":null},"revision":"sha256:4d39dc5f53ae18b0562fe8006ca4d83dc0e003dd8b12147a78dfe37f46e2fd44","parentRevision":null,"template":null,"formatVersion":2},"root":{"soulDir":"/Users/me/souls/example.soul","soulsRoot":"/Users/me/souls","source":"environment","registered":true,"marker":"ok","copies":[],"device":16777229},"components":[{"id":"manifest","path":"soul.json","classification":"definition","present":true,"retention":"durable"},{"id":"instructions","path":"AGENTS.md","classification":"definition","present":true,"retention":"durable"},{"id":"skills","path":"skills","classification":"definition","present":true,"retention":"durable","entries":["hello"]},{"id":"hooks","path":"hooks","classification":"definition","present":false,"retention":"durable"},{"id":"tools-bin","path":"bin","classification":"definition","present":true,"retention":"durable"},{"id":"workflows","path":"workflows","classification":"definition","present":false,"retention":"durable","entries":[]},{"id":"sop","path":"sop","classification":"definition","present":false,"retention":"durable"},{"id":"harness-pins","path":"package.json","classification":"definition","present":false,"retention":"durable"},{"id":"generated","path":null,"classification":"generated","present":true,"retention":"reconstructible","paths":[".claude/",".codex/",".cursor/",".opencode/",".devin/",".gemini/",".github/copilot-instructions.md",".mcp.json","CLAUDE.md","GEMINI.md","opencode.json",".github/hooks/agent-bot-soul.json",".github/agents/",".kiro/agents/",".kiro/settings/mcp.json"],"marker":"<!-- agent-bot soul-builder: generated -->","drift":[]},{"id":"workspaces","path":"worktrees","classification":"workspace","present":true,"retention":"durable","entries":[]},{"id":"home","path":".soul-state/home","classification":"private-home","present":true,"retention":"durable","git":false,"built":true,"harnessInstall":null},{"id":"tool-state","path":".soul-state/tools","classification":"private-home","present":false,"retention":"durable","entries":[{"harness":"claude","path":".soul-state/tools/claude","routing":[],"containment":"shared-host","hostPath":"/Users/me/.claude","signIn":"unknown"}]},{"id":"credentials","path":".soul-state/credentials","classification":"private-home","present":false,"retention":"durable","exportable":false,"declared":null},{"id":"runtimes","path":".soul-state/runtimes","classification":"runtime","present":false,"retention":"reconstructible"},{"id":"memory","path":".soul-state/space","classification":"memory","present":true,"retention":"durable","location":"linked","target":"/Users/me/space","contained":false,"spacePath":"/Users/me/space","status":"missing"},{"id":"history","path":".soul-state/runs","classification":"history","present":false,"retention":"durable","external":[{"what":"revision journal","path":"/Users/me/state/soul-revisions/agent_3db71bf8-733a-8253-a4ff-4a14e66d4ed9","present":true},{"what":"wake sessions","path":"/Users/me/state/agent-bot/wake-sessions.json","present":false},{"what":"launch requests","path":"/Users/me/state/agent-bot/launch-requests.json","present":false},{"what":"task turns","path":"/Users/me/state/agent-bot/task-turns.jsonl","present":false}],"confinementLog":false},{"id":"cache","path":".soul-state/cache","classification":"cache","present":false,"retention":"reconstructible"},{"id":"temp","path":".soul-state/tmp","classification":"temp","present":false,"retention":"disposable","entries":[]},{"id":"host-tools","path":null,"classification":"external","present":true,"retention":null,"entries":[{"name":"agent-bot","path":"/Applications/GeniusBar.app/Contents/Resources/components/agent-bot/agent-bot","source":"engine"},{"name":"agent-comms","path":"/Users/me/.local/bin/agent-comms","source":"host"},{"name":"git","path":"/usr/bin/git","source":"host"}]}],"classification":{"enum":["definition","generated","workspace","runtime","private-home","memory","history","cache","temp","external"],"rules":[{"match":"prefix","path":".soul-state/runtimes/","classification":"runtime"},{"match":"prefix","path":".soul-state/space/","classification":"memory"},{"match":"prefix","path":".soul-state/runs/","classification":"history"},{"match":"prefix","path":".soul-state/cache/","classification":"cache"},{"match":"prefix","path":".soul-state/tmp/","classification":"temp"},{"match":"prefix","path":".soul-state/","classification":"private-home"},{"match":"prefix","path":"worktrees/","classification":"workspace"},{"match":"generated","classification":"generated"},{"match":"default","classification":"definition"}]},"harnesses":{"selected":"claude","declared":[],"installed":[],"launchable":false},"runtimes":{"declared":{"node":{"version":"24.11.1"}},"installed":[],"missing":[{"name":"node","version":"24.11.1","reason":"not provisioned"}],"unsupported":[]},"providers":{},"launch":{"supported":true,"lane":"acp","cwd":"/Users/me/souls/example.soul/.soul-state/home","routing":{"HOME":"host","PATH":"host","TMPDIR":"host"},"limitations":[{"harness":"claude","message":"claude's native state (/Users/me/.claude) is shared on the host with every other soul until the launch environment contract routes it into the soul"}]},"readiness":{"ready":true,"problems":[]},"migration":{"status":"pending","journal":".soul-state/migration.json","steps":[{"id":"space-into-soul","status":"pending","from":"/Users/me/space","to":"/Users/me/souls/example.soul/.soul-state/space"}]},"retention":{"durable":["manifest","instructions","skills","hooks","tools-bin","workflows","sop","harness-pins","workspaces","home","tool-state","credentials","memory","history"],"reconstructible":["generated","runtimes","cache"],"disposable":["temp"]},"errors":[]}
"#;

    /// agent-bot 0.10.45's `soul` usage line: `soul profile`, but no
    /// `soul env`.
    const OLD_USAGE: &[u8] =
        b"agent-bot: usage: agent-bot soul cold-wake <agentId> [on|off|show] | soul show <agentId|name> [--json] | soul profile <agentId|name> [--json] [--file RELATIVE_PATH] | soul templates [--json] | soul spawn TEMPLATE_PATH --name NAME [--harness H]\n";

    #[test]
    fn parses_the_descriptor_as_the_engine_printed_it() {
        let env = parse_soul_env(ENV.as_bytes(), b"").unwrap();
        assert_eq!(env["schemaVersion"], 1);
        assert_eq!(env["engine"]["version"], "0.10.46");
        assert_eq!(env["engine"]["contractVersion"], 1);
        assert_eq!(
            env["engine"]["capabilities"],
            json!(["env", "revision-prepare"])
        );
        assert_eq!(env["root"]["soulDir"], "/Users/me/souls/example.soul");
        assert_eq!(env["root"]["marker"], "ok");
        let components = env["components"].as_array().unwrap();
        assert_eq!(components.len(), 19);
        assert!(components.iter().all(|c| {
            c.get("id").is_some_and(Value::is_string)
                && c.get("classification").is_some_and(Value::is_string)
                && c.get("present").is_some_and(Value::is_boolean)
        }));
        let generated = components.iter().find(|c| c["id"] == "generated").unwrap();
        assert_eq!(generated["paths"].as_array().unwrap().len(), 15);
        assert_eq!(generated["retention"], "reconstructible");
        assert_eq!(env["harnesses"]["selected"], "claude");
        assert_eq!(env["runtimes"]["missing"][0]["name"], "node");
        assert_eq!(env["launch"]["lane"], "acp");
        assert_eq!(env["readiness"]["ready"], true);
        assert_eq!(env["readiness"]["problems"], json!([]));
        assert_eq!(env["migration"]["steps"][0]["id"], "space-into-soul");
        assert_eq!(env["retention"]["disposable"], json!(["temp"]));
        assert_eq!(env["errors"], json!([]));
        // Nothing is dropped or reshaped on the way through.
        assert_eq!(env, serde_json::from_str::<Value>(ENV).unwrap());
    }

    #[test]
    fn passes_on_the_engines_refusal() {
        assert_eq!(
            parse_soul_env(
                b"{\"error\":{\"code\":\"soul-not-found\",\"message\":\"Soul not found.\"}}\n",
                b""
            )
            .unwrap_err(),
            BridgeError::new("soul-not-found", "Soul not found.")
        );
        assert_eq!(
            parse_soul_env(b"", b"agent-bot soul env: EACCES\n").unwrap_err(),
            BridgeError::new("soul-env-failed", "EACCES")
        );
        // A descriptor of another schema is not passed on as one.
        assert_eq!(
            parse_soul_env(
                b"{\"schemaVersion\":2,\"engine\":{},\"components\":[]}\n",
                b""
            )
            .unwrap_err()
            .code,
            "soul-env-failed"
        );
        assert_eq!(
            soul_argument("--help".into(), "agent", "soul-env-failed")
                .unwrap_err()
                .code,
            "soul-env-failed"
        );
    }

    #[test]
    fn an_older_bundle_is_unsupported_not_failed() {
        assert_eq!(
            parse_soul_env(b"", OLD_USAGE).unwrap_err(),
            BridgeError::new(
                "soul-env-unsupported",
                "this agent-bot has no soul environment"
            )
        );
        // A bundle that has the command but refuses its arguments still has it.
        assert_eq!(
            parse_soul_env(
                b"{\"error\":{\"code\":\"soul-env-failed\",\"message\":\"usage: agent-bot soul env <agentId|name> [--json]\"}}\n",
                b""
            )
            .unwrap_err()
            .code,
            "soul-env-failed"
        );
    }

    #[test]
    fn gates_on_the_engines_capabilities_not_its_version() {
        let env: Value = serde_json::from_str(ENV).unwrap();
        assert!(engine_has(&env, "revision-prepare"));
        assert!(engine_has(&env, "env"));
        assert!(!engine_has(&env, "provision"));
        let mut older = env.clone();
        older["engine"]["capabilities"] = json!(["env"]);
        assert!(!engine_has(&older, "revision-prepare"));
        older["engine"]["version"] = json!("9.9.9");
        assert!(!engine_has(&older, "revision-prepare"));
        assert!(!engine_has(&json!({}), "revision-prepare"));
        assert!(!engine_has(
            &json!({"engine": {"capabilities": "revision-prepare"}}),
            "revision-prepare"
        ));
        assert_eq!(
            soul_env_args("agent_p"),
            vec!["soul", "env", "agent_p", "--json"]
        );
    }
}

/// The owner's edits from the Customize dialog's Save (#64): the soul's
/// manifest name, description and appearance, and the text of its editable
/// Context files, keyed by their path in the package.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoulRevisionEdit {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// The manifest's `appearance` (agent-bot `appearance.hue`, 0..359):
    /// absent leaves it alone, `null` removes it, `{ "hue": N }` sets it.
    #[serde(default)]
    appearance: Option<Value>,
    /// The manifest's `role` (agent-bot-identity #535): absent leaves it
    /// alone, empty removes it, otherwise one line of at most 60 characters.
    #[serde(default)]
    role: Option<String>,
    /// The manifest's `skills.disabled` (agent-bot 0.10.43, #64): absent
    /// leaves it alone; `{ "disabled": [names] }` is the whole list of the
    /// package's skills switched off, and an empty list removes the key.
    #[serde(default)]
    skills: Option<Value>,
    #[serde(default)]
    files: std::collections::BTreeMap<String, String>,
}

/// `soul profile --file`'s limit, kept for what Save writes back.
const MAX_EDIT_BYTES: usize = 256 * 1024;
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 2000;
/// agent-bot trims a soul's role to 60 characters (`withRoles`).
const MAX_ROLE_CHARS: usize = 60;
const MAX_REASON_CHARS: usize = 200;

impl SoulRevisionEdit {
    fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.description.is_none()
            && self.appearance.is_none()
            && self.role.is_none()
            && self.skills.is_none()
            && self.files.is_empty()
    }
}

/// One file of a staged package, as the engine's `soul revision prepare`
/// rows say it (#268): `editable` is the engine's word (the definition,
/// never `soul.json` or `bin/`), `text` whether the bytes are UTF-8. The
/// dialog edits only a file that is both, and Save checks the same rows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StagedFile {
    path: String,
    editable: bool,
    text: bool,
}

/// A staging `soul revision prepare` made: where it is, the revision it was
/// taken from, and the engine's rows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedRevision {
    agent_id: String,
    staging: std::path::PathBuf,
    revision: Option<String>,
    files: Vec<StagedFile>,
}

/// The stagings this app prepared and has not finished (#268), by path,
/// with the engine's rows: `soul_revision_edit` consumes one and
/// `soul_revision_discard` drops one. A dialog that closes without either
/// leaves temp the engine expires (24 hours).
#[derive(Default)]
pub struct PreparedRevisions(Mutex<HashMap<std::path::PathBuf, PreparedRevision>>);

impl PreparedRevisions {
    fn insert(&self, record: PreparedRevision) {
        self.0
            .lock()
            .unwrap()
            .insert(record.staging.clone(), record);
    }

    fn take(&self, staging: &std::path::Path) -> Option<PreparedRevision> {
        self.0.lock().unwrap().remove(staging)
    }
}

/// Stages the soul's definition for a Customize dialog (#268): with the
/// engine's `revision-prepare` capability, `soul revision prepare <agentId>
/// --json`, answered as printed (`{schemaVersion, agentId, soulDir, staging,
/// revision, parentRevision, files[], excluded, expiresAt}`, each file
/// `{path, classification, kind, editable, text, size, mode}`), and the
/// staging kept here for Save or Cancel. The dialog reads `editable` from
/// the rows and decides nothing itself. Without the capability the same
/// shape comes from `soul profile` and the app's own rules
/// (`legacy_prepare`), with `staging` null: Save then stages for itself.
#[tauri::command]
pub async fn soul_revision_prepare<R: Runtime>(
    app: AppHandle<R>,
    prepared: State<'_, PreparedRevisions>,
    agent: String,
) -> Result<Value, BridgeError> {
    let agent = soul_argument(agent, "agent", "soul-revision-failed")?;
    if revision_prepare_supported(&app, &agent).await? {
        let record = prepare_staging(&app, &agent).await?;
        prepared.insert(prepared_revision(&record)?);
        return Ok(record);
    }
    let profile = read_profile(&app, &agent).await?;
    Ok(legacy_prepare::inventory(&profile))
}

/// Removes a staging `soul_revision_prepare` made and the dialog gave up on
/// (#268): `soul revision prepare --discard <staging> --json`, which the
/// engine limits to a `revision-<uuid>` directory under a soul's
/// `.soul-state/tmp/` (`staging-not-temp` otherwise, `staging-missing` when
/// it is gone already). Answers `{discarded}`.
#[tauri::command]
pub async fn soul_revision_discard<R: Runtime>(
    app: AppHandle<R>,
    prepared: State<'_, PreparedRevisions>,
    staging: String,
) -> Result<Value, BridgeError> {
    let staging = staging_path(&staging)?;
    prepared.take(&staging);
    discard_staging(&app, &staging).await
}

/// Records the owner's Customize edits as a new revision of the soul's
/// package (#64, agent-bot-identity #293, `docs/soul-revisions.md`): the
/// edits are written into a staging of the package and `soul revision edit
/// <agentId> <staging> <reason> --apply` records and publishes them,
/// owner-gating the change itself (as `soul remove` does; GeniusBar presents
/// no principal). Refuses when the revision moved since the dialog read it
/// (`soul-revision-stale`). The staging is the one the dialog prepared
/// (`staging`, from `soul_revision_prepare`), else one made here: by the
/// engine when it has `revision-prepare` (asked afresh on each call), else
/// the app's own copy (`legacy_prepare`). Either way it is consumed:
/// applied or not, the dialog prepares again. Answers the revision record
/// (`revision`, `parentRevision`, `author`, `reason`, `authorization`, ...).
#[tauri::command]
pub async fn soul_revision_edit<R: Runtime>(
    app: AppHandle<R>,
    prepared: State<'_, PreparedRevisions>,
    agent: String,
    expected_revision: Option<String>,
    reason: String,
    edit: SoulRevisionEdit,
    staging: Option<String>,
) -> Result<Value, BridgeError> {
    let agent = soul_argument(agent, "agent", "soul-revision-failed")?;
    // The dialog's staging is taken first: whatever follows, it is consumed.
    let record = match staging {
        Some(staging) => {
            let staging = staging_path(&staging)?;
            Some(prepared.take(&staging).ok_or_else(|| {
                revision_invalid("the staging is not one this app prepared; open the dialog again")
            })?)
        }
        None => None,
    };
    let checked = async {
        let reason = revision_reason(&reason)?;
        if edit.is_empty() {
            return Err(revision_invalid("nothing changed"));
        }
        // The profile names the package's skills (for `skills.disabled`)
        // and, without the engine's staging, the package and its inventory.
        let profile = read_profile(&app, &agent).await?;
        let manifest = check_manifest_edit(&edit, &profile)?;
        Ok((reason, profile, manifest))
    }
    .await;
    let (reason, profile, manifest) = match checked {
        Ok(checked) => checked,
        Err(error) => {
            if let Some(record) = &record {
                let _ = discard_staging(&app, &record.staging).await;
            }
            return Err(error);
        }
    };
    let record = match record {
        Some(record) => Some(record),
        None => {
            if revision_prepare_supported(&app, &agent).await? {
                Some(prepared_revision(&prepare_staging(&app, &agent).await?)?)
            } else {
                None
            }
        }
    };
    match record {
        Some(record) => {
            finish_prepared(
                &app,
                record,
                expected_revision.as_deref(),
                &edit,
                &manifest,
                &reason,
            )
            .await
        }
        None => {
            legacy_prepare::edit(
                &app,
                &profile,
                expected_revision.as_deref(),
                &edit,
                &manifest,
                &reason,
            )
            .await
        }
    }
}

/// Writes the edit into the engine's staging and finishes it with `soul
/// revision edit --apply`; the staging is discarded afterwards whether the
/// engine recorded it or refused.
async fn finish_prepared<R: Runtime>(
    app: &AppHandle<R>,
    record: PreparedRevision,
    expected_revision: Option<&str>,
    edit: &SoulRevisionEdit,
    manifest: &ManifestEdit,
    reason: &str,
) -> Result<Value, BridgeError> {
    let result = async {
        if expected_revision.is_some() && record.revision.as_deref() != expected_revision {
            return Err(revision_stale());
        }
        write_revision_edit(&record.staging, edit, manifest, &record.files)?;
        let args = soul_revision_edit_args(&record.agent_id, &record.staging, reason)?;
        let output = run_agent_bot(app, args, "soul-revision-unavailable").await?;
        parse_soul_revision_edit(&output.stdout, &output.stderr)
    }
    .await;
    // A leftover would be harmless temp; removing it keeps the soul tidy.
    let _ = discard_staging(app, &record.staging).await;
    result
}

async fn read_profile<R: Runtime>(app: &AppHandle<R>, agent: &str) -> Result<Value, BridgeError> {
    let args = vec![
        "soul".into(),
        "profile".into(),
        agent.into(),
        "--json".into(),
    ];
    let output = run_agent_bot(app, args, "soul-revision-unavailable").await?;
    parse_soul_profile(&output.stdout, &output.stderr)
}

/// `soul revision prepare <agentId> --json`, as printed.
async fn prepare_staging<R: Runtime>(
    app: &AppHandle<R>,
    agent: &str,
) -> Result<Value, BridgeError> {
    let args = vec![
        "soul".into(),
        "revision".into(),
        "prepare".into(),
        agent.into(),
        "--json".into(),
    ];
    let output = run_agent_bot(app, args, "soul-revision-unavailable").await?;
    parse_revision_prepare(&output.stdout, &output.stderr)
}

async fn discard_staging<R: Runtime>(
    app: &AppHandle<R>,
    staging: &std::path::Path,
) -> Result<Value, BridgeError> {
    let output = run_agent_bot(app, discard_args(staging), "soul-revision-unavailable").await?;
    parse_revision_discard(&output.stdout, &output.stderr)
}

fn discard_args(staging: &std::path::Path) -> Vec<std::ffi::OsString> {
    vec![
        "soul".into(),
        "revision".into(),
        "prepare".into(),
        "--discard".into(),
        staging.as_os_str().to_owned(),
        "--json".into(),
    ]
}

/// The staging record agent-bot printed, or its refusal (`soul-not-found`,
/// `soul-state-missing` for a soul never launched, ...).
fn parse_revision_prepare(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if let Ok(record) = serde_json::from_str::<Value>(&last_line(stdout)) {
        if record.get("agentId").and_then(Value::as_str).is_some()
            && record.get("staging").and_then(Value::as_str).is_some()
            && record.get("files").is_some_and(Value::is_array)
        {
            return Ok(record);
        }
    }
    Err(revision_refusal(stderr, "agent-bot staged no revision"))
}

fn parse_revision_discard(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if let Ok(record) = serde_json::from_str::<Value>(&last_line(stdout)) {
        if record.get("discarded").and_then(Value::as_str).is_some() {
            return Ok(record);
        }
    }
    Err(revision_refusal(stderr, "agent-bot discarded no staging"))
}

/// The staging the engine described, checked before the app writes into
/// it: the path has the engine's shape, the rows carry paths.
fn prepared_revision(record: &Value) -> Result<PreparedRevision, BridgeError> {
    let agent_id = record
        .get("agentId")
        .and_then(Value::as_str)
        .filter(|id| id.starts_with("agent_"))
        .ok_or_else(|| revision_invalid("agent-bot gave no Agent ID"))?;
    let staging = staging_path(
        record
            .get("staging")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let files = record
        .get("files")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(StagedFile {
                        path: row.get("path")?.as_str()?.to_string(),
                        editable: row.get("editable").and_then(Value::as_bool) == Some(true),
                        text: row.get("text").and_then(Value::as_bool) == Some(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(PreparedRevision {
        agent_id: agent_id.to_string(),
        staging,
        revision: record
            .get("revision")
            .and_then(Value::as_str)
            .map(str::to_string),
        files,
    })
}

/// A staging path as the engine makes them: absolute, `revision-<uuid>`
/// directly under a soul's `.soul-state/tmp/`. Anything else never reaches
/// agent-bot (`--discard` would refuse it too).
fn staging_path(path: &str) -> Result<std::path::PathBuf, BridgeError> {
    let invalid = || revision_invalid("not a revision staging");
    let staging = std::path::PathBuf::from(path);
    if !staging.is_absolute() || path.chars().any(char::is_control) {
        return Err(invalid());
    }
    let name = staging
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(invalid)?;
    let uuid = name.strip_prefix("revision-").ok_or_else(invalid)?;
    let uuid_shaped = uuid.len() == 36
        && uuid.chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    let tmp = staging.parent().ok_or_else(invalid)?;
    let state = tmp.parent().ok_or_else(invalid)?;
    if !uuid_shaped
        || tmp.file_name().and_then(|n| n.to_str()) != Some("tmp")
        || state.file_name().and_then(|n| n.to_str()) != Some(".soul-state")
    {
        return Err(invalid());
    }
    Ok(staging)
}

fn revision_invalid(message: &str) -> BridgeError {
    BridgeError::new("soul-revision-invalid", message)
}

fn revision_stale() -> BridgeError {
    BridgeError::new(
        "soul-revision-stale",
        "the package changed since the dialog read it",
    )
}

/// agent-bot's `soul revision` refusal on stderr, `agent-bot soul revision:
/// [code: ]message`: a coded one keeps its code, a stale parent maps to
/// `soul-revision-stale`, anything else to `soul-revision-failed`.
fn revision_refusal(stderr: &[u8], fallback: &str) -> BridgeError {
    let line = last_line(stderr);
    let message = line
        .strip_prefix("agent-bot soul revision: ")
        .unwrap_or(&line);
    if message.contains("stale proposal or edit") {
        return BridgeError::new("soul-revision-stale", message);
    }
    if let Some((code, rest)) = message.split_once(": ") {
        let coded = code.contains('-')
            && code
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if coded {
            return BridgeError::new(code, rest);
        }
    }
    BridgeError::new(
        "soul-revision-failed",
        if message.is_empty() {
            fallback
        } else {
            message
        },
    )
}

/// A one-line reason agent-bot cannot read as a flag.
fn revision_reason(reason: &str) -> Result<String, BridgeError> {
    let reason = reason.trim();
    if reason.is_empty()
        || reason.starts_with('-')
        || reason.chars().any(char::is_control)
        || reason.chars().count() > MAX_REASON_CHARS
    {
        return Err(revision_invalid(
            "the reason must be one line of at most 200 characters",
        ));
    }
    Ok(reason.to_string())
}

/// A package-relative path without traversal, absolute roots, backslashes
/// or control characters (agent-bot's `safeRelative`).
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// The staging's regular file at `path`, every component checked without
/// following a symlink.
fn staged_file(root: &std::path::Path, path: &str) -> Result<std::path::PathBuf, BridgeError> {
    let mut current = root.to_path_buf();
    for part in path.split('/') {
        current.push(part);
        let meta = std::fs::symlink_metadata(&current)
            .map_err(|_| revision_invalid(&format!("{path} is not in the package")))?;
        if meta.file_type().is_symlink() {
            return Err(revision_invalid(&format!("{path} is a link")));
        }
    }
    if !std::fs::symlink_metadata(&current).is_ok_and(|m| m.is_file()) {
        return Err(revision_invalid(&format!("{path} is not a file")));
    }
    Ok(current)
}

/// A manifest field: trimmed, nonempty, one line, at most `max` characters.
fn manifest_text(
    value: &str,
    what: &str,
    max: usize,
    multiline: bool,
) -> Result<String, BridgeError> {
    let value = value.trim();
    let bad = |c: char| c.is_control() && !(multiline && (c == '\n' || c == '\t'));
    if value.is_empty() || value.chars().count() > max || value.chars().any(bad) {
        return Err(revision_invalid(&format!(
            "the {what} must be nonempty text of at most {max} characters"
        )));
    }
    Ok(value.to_string())
}

/// The `appearance` an edit asks for: `null` removes the key (`Ok(None)`),
/// `{ "hue": N }` with an integer 0..359 sets it (`Ok(Some(N))`); agent-bot
/// accepts nothing else, so nothing else is sent.
fn manifest_appearance(value: &Value) -> Result<Option<u64>, BridgeError> {
    if value.is_null() {
        return Ok(None);
    }
    let hue = value
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.get("hue"))
        .and_then(Value::as_u64)
        .filter(|hue| *hue <= 359);
    match hue {
        Some(hue) => Ok(Some(hue)),
        None => Err(revision_invalid(
            "the appearance must be null or a hue from 0 to 359",
        )),
    }
}

/// The `skills.disabled` list an edit asks for: `{ "disabled": [names] }`,
/// each a skill `profile` lists (agent-bot refuses an unknown name too, but
/// after the copy; here is sooner), deduplicated and sorted.
fn manifest_skills(value: &Value, profile: &Value) -> Result<Vec<String>, BridgeError> {
    let invalid =
        || revision_invalid("skills must be { \"disabled\": [names] } naming the package's skills");
    let disabled = value
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.get("disabled"))
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let known: std::collections::BTreeSet<&str> = profile
        .get("skills")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let mut names = std::collections::BTreeSet::new();
    for name in disabled {
        let name = name
            .as_str()
            .filter(|n| known.contains(n))
            .ok_or_else(invalid)?;
        names.insert(name.to_string());
    }
    Ok(names.into_iter().collect())
}

/// The manifest fields an edit sets, checked before anything is staged.
#[derive(Debug, Default, PartialEq, Eq)]
struct ManifestEdit {
    name: Option<String>,
    description: Option<String>,
    /// `Some(None)` removes the key.
    appearance: Option<Option<u64>>,
    /// `Some(None)` removes the key.
    role: Option<Option<String>>,
    skills: Option<Vec<String>>,
}

impl ManifestEdit {
    fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.description.is_none()
            && self.appearance.is_none()
            && self.role.is_none()
            && self.skills.is_none()
    }
}

/// Checks the edit's manifest fields and the size of its files (their
/// paths are checked against the staging's rows when they are written).
fn check_manifest_edit(
    edit: &SoulRevisionEdit,
    profile: &Value,
) -> Result<ManifestEdit, BridgeError> {
    for (path, contents) in &edit.files {
        if !safe_relative(path) {
            return Err(revision_invalid(&format!("{path} cannot be edited here")));
        }
        if contents.len() > MAX_EDIT_BYTES || contents.contains('\0') {
            return Err(revision_invalid(&format!(
                "{path} must be text of at most 256 KiB"
            )));
        }
    }
    Ok(ManifestEdit {
        name: edit
            .name
            .as_deref()
            .map(|n| manifest_text(n, "name", MAX_NAME_CHARS, false))
            .transpose()?,
        description: edit
            .description
            .as_deref()
            .map(|d| manifest_text(d, "description", MAX_DESCRIPTION_CHARS, true))
            .transpose()?,
        appearance: edit
            .appearance
            .as_ref()
            .map(manifest_appearance)
            .transpose()?,
        // An empty role removes the key (`Some(None)`).
        role: edit
            .role
            .as_deref()
            .map(|r| {
                if r.trim().is_empty() {
                    Ok(None)
                } else {
                    manifest_text(r, "role", MAX_ROLE_CHARS, false).map(Some)
                }
            })
            .transpose()?,
        skills: edit
            .skills
            .as_ref()
            .map(|value| manifest_skills(value, profile))
            .transpose()?,
    })
}

/// Writes the edit into the staged package at `root`: each file the edit
/// names must be one the rows mark editable text (the engine's word, or
/// `legacy_prepare`'s), then the manifest fields go into its `soul.json`.
fn write_revision_edit(
    root: &std::path::Path,
    edit: &SoulRevisionEdit,
    manifest: &ManifestEdit,
    files: &[StagedFile],
) -> Result<(), BridgeError> {
    for path in edit.files.keys() {
        let staged = files.iter().find(|f| f.path == *path);
        if !staged.is_some_and(|f| f.editable && f.text) {
            return Err(revision_invalid(&format!("{path} cannot be edited here")));
        }
    }
    let failed = |e: std::io::Error| BridgeError::new("soul-revision-failed", &e.to_string());
    for (path, contents) in &edit.files {
        let file = staged_file(root, path)?;
        std::fs::write(&file, contents).map_err(failed)?;
    }
    if manifest.is_empty() {
        return Ok(());
    }
    let file = staged_file(root, "soul.json")?;
    let text = std::fs::read_to_string(&file).map_err(failed)?;
    let mut out: serde_json::Map<String, Value> = serde_json::from_str(&text)
        .map_err(|_| revision_invalid("the package's soul.json is not a JSON object"))?;
    if let Some(name) = &manifest.name {
        out.insert("name".into(), Value::String(name.clone()));
    }
    if let Some(description) = &manifest.description {
        out.insert("description".into(), Value::String(description.clone()));
    }
    match manifest.appearance {
        Some(Some(hue)) => {
            out.insert("appearance".into(), json!({ "hue": hue }));
        }
        Some(None) => {
            out.remove("appearance");
        }
        None => {}
    }
    match &manifest.role {
        Some(Some(role)) => {
            out.insert("role".into(), Value::String(role.clone()));
        }
        Some(None) => {
            out.remove("role");
        }
        None => {}
    }
    if let Some(disabled) = &manifest.skills {
        // Other `skills` keys agent-bot may grow are kept; an empty list
        // leaves no `disabled`, and no `skills` at all when nothing else
        // is in it.
        let mut declaration = out
            .remove("skills")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        if disabled.is_empty() {
            declaration.remove("disabled");
        } else {
            declaration.insert(
                "disabled".into(),
                Value::Array(disabled.iter().cloned().map(Value::String).collect()),
            );
        }
        if !declaration.is_empty() {
            out.insert("skills".into(), Value::Object(declaration));
        }
    }
    // agent-bot sets parentRevision and recomputes revision when it
    // records the edit; the staging keeps the package's.
    let mut text = serde_json::to_string_pretty(&out)
        .map_err(|e| BridgeError::new("soul-revision-failed", &e.to_string()))?;
    text.push('\n');
    std::fs::write(&file, text).map_err(failed)
}

fn soul_revision_edit_args(
    agent_id: &str,
    package: &std::path::Path,
    reason: &str,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if !agent_id.starts_with("agent_") || !package.is_absolute() {
        return Err(revision_invalid("not a soul revision edit"));
    }
    Ok(vec![
        "soul".into(),
        "revision".into(),
        "edit".into(),
        agent_id.into(),
        package.as_os_str().to_owned(),
        reason.into(),
        "--apply".into(),
    ])
}

/// The revision record agent-bot printed, or its refusal.
fn parse_soul_revision_edit(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    if let Ok(record) = serde_json::from_str::<Value>(&last_line(stdout)) {
        if record.get("revision").and_then(Value::as_str).is_some() {
            return Ok(record);
        }
    }
    Err(revision_refusal(stderr, "agent-bot recorded no revision"))
}

/// The app's own staging of a package for a revision edit, from before the
/// engine staged it (#268): copies of agent-bot's generated paths and
/// working-state names, a private temporary copy of the package, and the
/// app's editability rule. Dead once the bundled agent-bot is 0.10.46 or
/// later (`soul env` reports `revision-prepare`); only a downgraded bundle
/// reaches it, through `soul_revision_prepare` and `soul_revision_edit`.
/// Delete this module with the next bundle floor.
mod legacy_prepare {
    use super::*;

    /// soul-builder's mark on the files it writes (agent-bot
    /// `soul-harness-contract.mjs`); such a file is rebuilt, never edited.
    const GENERATED_MARKER: &str = "<!-- agent-bot soul-builder: generated -->";
    /// agent-bot's generated harness paths as of 0.10.45; a trailing `/`
    /// covers a whole directory. The engine's list has grown since (the
    /// descriptor's `generated.paths`), which is why it is no longer copied.
    const GENERATED_PATHS: [&str; 11] = [
        ".claude/",
        ".codex/",
        ".cursor/",
        ".opencode/",
        ".devin/",
        ".gemini/",
        ".github/copilot-instructions.md",
        ".mcp.json",
        "CLAUDE.md",
        "GEMINI.md",
        "opencode.json",
    ];
    /// Working state beside the package (format 2's ignore list): never copied.
    const WORKING_STATE: [&str; 2] = ["worktrees", ".soul-state"];

    /// The inventory `soul_revision_prepare` answers without the engine's
    /// staging, in `soul revision prepare`'s shape with `staging` null:
    /// the profile's files with the app's editability rule.
    pub(super) fn inventory(profile: &Value) -> Value {
        let files: Vec<Value> = profile
            .get("files")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let path = row.get("path")?.as_str()?;
                        Some(json!({
                            "path": path,
                            "classification": Value::Null,
                            "kind": row.get("kind").cloned().unwrap_or(Value::Null),
                            "editable": editable(profile, path),
                            "text": row.get("text").and_then(Value::as_bool) == Some(true),
                            "size": row.get("size").cloned().unwrap_or(Value::Null),
                            "mode": Value::Null,
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({
            "schemaVersion": 1,
            "agentId": profile.get("agentId").cloned().unwrap_or(Value::Null),
            "soulDir": profile["profile"].get("package").cloned().unwrap_or(Value::Null),
            "staging": Value::Null,
            "revision": profile["profile"].get("revision").cloned().unwrap_or(Value::Null),
            "parentRevision": Value::Null,
            "files": files,
            "excluded": { "workingState": [], "generated": [] },
            "expiresAt": Value::Null,
        })
    }

    /// The rows `write_revision_edit` checks, from the same rule.
    pub(super) fn rows(profile: &Value) -> Vec<StagedFile> {
        profile
            .get("files")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let path = row.get("path")?.as_str()?;
                        Some(StagedFile {
                            path: path.to_string(),
                            editable: editable(profile, path),
                            text: row.get("text").and_then(Value::as_bool) == Some(true),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Copies the package into a private temporary directory, writes the
    /// edit there and records it; the copy is removed afterwards.
    pub(super) async fn edit<R: Runtime>(
        app: &AppHandle<R>,
        profile: &Value,
        expected_revision: Option<&str>,
        edit: &SoulRevisionEdit,
        manifest: &ManifestEdit,
        reason: &str,
    ) -> Result<Value, BridgeError> {
        let copy = RevisionCopy::new()?;
        let (agent_id, root) = stage(profile, expected_revision, copy.path())?;
        refuse_generated_marker(&root, edit)?;
        write_revision_edit(&root, edit, manifest, &rows(profile))?;
        let args = soul_revision_edit_args(&agent_id, &root, reason)?;
        let output = run_agent_bot(app, args, "soul-revision-unavailable").await?;
        drop(copy);
        parse_soul_revision_edit(&output.stdout, &output.stderr)
    }

    /// Checks the revision against `profile` (`soul profile --json`) and
    /// copies the package into `temp`. Answers the soul's Agent ID and the
    /// copy.
    pub(super) fn stage(
        profile: &Value,
        expected_revision: Option<&str>,
        temp: &std::path::Path,
    ) -> Result<(String, std::path::PathBuf), BridgeError> {
        let agent_id = profile
            .get("agentId")
            .and_then(Value::as_str)
            .filter(|id| id.starts_with("agent_"))
            .ok_or_else(|| revision_invalid("agent-bot gave no Agent ID"))?;
        let facts = &profile["profile"];
        if expected_revision.is_some()
            && facts.get("revision").and_then(Value::as_str) != expected_revision
        {
            return Err(revision_stale());
        }
        let package = facts
            .get("package")
            .and_then(Value::as_str)
            .filter(|p| p.starts_with('/'))
            .ok_or_else(|| revision_invalid("agent-bot gave no package folder"))?;
        if !std::fs::symlink_metadata(package).is_ok_and(|m| m.is_dir()) {
            return Err(revision_invalid("the package folder is not a folder"));
        }
        let copy = temp.join("edit.soul");
        copy_package(std::path::Path::new(package), &copy, true)?;
        Ok((agent_id.to_string(), copy))
    }

    /// A file that carries soul-builder's mark is generated wherever it is.
    pub(super) fn refuse_generated_marker(
        root: &std::path::Path,
        edit: &SoulRevisionEdit,
    ) -> Result<(), BridgeError> {
        for path in edit.files.keys() {
            let file = staged_file(root, path)?;
            let before = std::fs::read(&file)
                .map_err(|e| BridgeError::new("soul-revision-failed", &e.to_string()))?;
            if String::from_utf8_lossy(&before).contains(GENERATED_MARKER) {
                return Err(revision_invalid(&format!(
                    "{path} is generated; edit its source instead"
                )));
            }
        }
        Ok(())
    }

    /// A private directory (0700) for the edited copy, removed when dropped.
    pub(super) struct RevisionCopy(std::path::PathBuf);

    impl RevisionCopy {
        pub(super) fn new() -> Result<Self, BridgeError> {
            Self::under(&std::env::temp_dir())
        }

        fn under(parent: &std::path::Path) -> Result<Self, BridgeError> {
            // The clock alone is not unique: two edits in one process within the
            // clock's resolution (the test suite on CI) named the same directory
            // and the second failed with EEXIST. A per-process counter makes
            // every name distinct.
            static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let serial = SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = parent.join(format!(
                "geniusbar-revision-{}-{nanos}-{serial}",
                std::process::id()
            ));
            let mut builder = std::fs::DirBuilder::new();
            // On Windows the temp directory is already the user's own
            // (ADR-0046): a plain create.
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&dir)
                .map_err(|e| BridgeError::new("soul-revision-failed", &e.to_string()))?;
            Ok(Self(dir))
        }

        pub(super) fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for RevisionCopy {
        fn drop(&mut self) {
            // remove_dir_all never follows a symlink out of the copy.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn generated_path(path: &str) -> bool {
        GENERATED_PATHS.iter().any(|candidate| {
            if candidate.ends_with('/') {
                path.starts_with(candidate)
            } else {
                path == *candidate
            }
        })
    }

    /// True when the profile lists `path` as a file the owner may edit:
    /// the soul's own instructions, AGENTS.md and its skills. Never
    /// soul.json (its fields go through the manifest edit), working state,
    /// harness settings or a generated file. Text is the row's own flag.
    fn editable(profile: &Value, path: &str) -> bool {
        safe_relative(path)
            && path != "soul.json"
            && !path.starts_with(".soul-state/")
            && !generated_path(path)
            && profile
                .get("files")
                .and_then(Value::as_array)
                .is_some_and(|files| {
                    files.iter().any(|file| {
                        file.get("path").and_then(Value::as_str) == Some(path)
                            && matches!(
                                file.get("kind").and_then(Value::as_str),
                                Some("soul" | "context" | "skill")
                            )
                    })
                })
    }

    /// Copies the package at `from` into `to` without following a symlink:
    /// a symlink or special file anywhere refuses the copy; working state at
    /// the top is left out. Execute bits survive (`fs::copy` keeps them).
    fn copy_package(
        from: &std::path::Path,
        to: &std::path::Path,
        top: bool,
    ) -> Result<(), BridgeError> {
        let failed = |e: std::io::Error| BridgeError::new("soul-revision-failed", &e.to_string());
        std::fs::create_dir_all(to).map_err(failed)?;
        for entry in std::fs::read_dir(from).map_err(failed)? {
            let entry = entry.map_err(failed)?;
            let name = entry.file_name();
            if top && WORKING_STATE.iter().any(|skip| name == *skip) {
                continue;
            }
            let source = entry.path();
            let target = to.join(&name);
            let kind = std::fs::symlink_metadata(&source)
                .map_err(failed)?
                .file_type();
            if kind.is_dir() {
                copy_package(&source, &target, false)?;
            } else if kind.is_file() {
                std::fs::copy(&source, &target).map_err(failed)?;
            } else {
                return Err(revision_invalid(&format!(
                    "the package has a link or special file: {}",
                    name.to_string_lossy()
                )));
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn marker() -> &'static str {
        GENERATED_MARKER
    }
}

#[cfg(test)]
mod soul_revision_prepare_tests {
    use super::legacy_prepare::RevisionCopy;
    use super::*;

    /// agent-bot 0.10.46's `soul revision prepare <id> --json` for a built
    /// soul with an authored `.mcp.json`, a `bin/` tool, a policy file and
    /// a binary skill asset (temp paths shortened).
    const PREPARE: &str = r#"{"schemaVersion":1,"agentId":"agent_3db71bf8-733a-8253-a4ff-4a14e66d4ed9","soulDir":"/Users/me/souls/example.soul","staging":"/Users/me/souls/example.soul/.soul-state/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb","revision":"sha256:4d39dc5f53ae18b0562fe8006ca4d83dc0e003dd8b12147a78dfe37f46e2fd44","parentRevision":null,"files":[{"path":".mcp.json","classification":"generated","kind":null,"editable":false,"text":true,"size":235,"mode":"100644"},{"path":"AGENTS.md","classification":"definition","kind":"context","editable":true,"text":true,"size":22,"mode":"100644"},{"path":"bin/run","classification":"definition","kind":null,"editable":false,"text":true,"size":19,"mode":"100755"},{"path":"policy.json","classification":"definition","kind":null,"editable":true,"text":true,"size":15,"mode":"100644"},{"path":"skills/hello/SKILL.md","classification":"definition","kind":"skill","editable":true,"text":true,"size":46,"mode":"100644"},{"path":"skills/hello/diagram.png","classification":"definition","kind":"skill","editable":true,"text":false,"size":4,"mode":"100644"},{"path":"soul.json","classification":"definition","kind":"soul","editable":false,"text":true,"size":647,"mode":"100644"},{"path":"soul.md","classification":"definition","kind":"soul","editable":true,"text":true,"size":10,"mode":"100644"}],"excluded":{"workingState":["worktrees",".soul-state"],"generated":[".claude/skills/hello/SKILL.md",".codex/config.toml",".cursor/mcp.json",".gemini/settings.json",".gemini/skills/hello/SKILL.md","CLAUDE.md","GEMINI.md","opencode.json",".kiro/settings/mcp.json"]},"expiresAt":"2026-10-08T23:48:48.629Z"}
"#;
    const STAGING: &str =
        "/Users/me/souls/example.soul/.soul-state/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb";

    fn staged(path: &str, editable: bool, text: bool) -> StagedFile {
        StagedFile {
            path: path.into(),
            editable,
            text,
        }
    }

    #[test]
    fn parses_the_staging_record_and_its_rows() {
        let record = parse_revision_prepare(PREPARE.as_bytes(), b"").unwrap();
        assert_eq!(record["staging"], STAGING);
        assert_eq!(
            record["excluded"]["workingState"],
            json!(["worktrees", ".soul-state"])
        );
        assert_eq!(record["expiresAt"], "2026-10-08T23:48:48.629Z");
        assert_eq!(record, serde_json::from_str::<Value>(PREPARE).unwrap());
        let prepared = prepared_revision(&record).unwrap();
        assert_eq!(
            prepared.agent_id,
            "agent_3db71bf8-733a-8253-a4ff-4a14e66d4ed9"
        );
        assert_eq!(prepared.staging, std::path::Path::new(STAGING));
        assert_eq!(
            prepared.revision.as_deref(),
            Some("sha256:4d39dc5f53ae18b0562fe8006ca4d83dc0e003dd8b12147a78dfe37f46e2fd44")
        );
        // The engine's word on each file, nothing decided here: a policy
        // file of no profile kind is editable, a bin/ tool and the authored
        // generated file are not, a binary skill asset is editable but not
        // text, soul.json goes through the manifest edit.
        assert_eq!(
            prepared.files,
            vec![
                staged(".mcp.json", false, true),
                staged("AGENTS.md", true, true),
                staged("bin/run", false, true),
                staged("policy.json", true, true),
                staged("skills/hello/SKILL.md", true, true),
                staged("skills/hello/diagram.png", true, false),
                staged("soul.json", false, true),
                staged("soul.md", true, true),
            ]
        );
    }

    #[test]
    fn passes_on_the_engines_refusal_to_stage() {
        assert_eq!(
            parse_revision_prepare(
                b"",
                b"agent-bot soul revision: soul-not-found: Soul not found.\n"
            )
            .unwrap_err(),
            BridgeError::new("soul-not-found", "Soul not found.")
        );
        assert_eq!(
            parse_revision_prepare(
                b"",
                b"agent-bot soul revision: soul-state-missing: the soul has no .soul-state directory yet; launch it once, or pass --dest\n"
            )
            .unwrap_err()
            .code,
            "soul-state-missing"
        );
        assert_eq!(
            parse_revision_prepare(b"{\"agentId\":\"agent_p\"}\n", b"").unwrap_err(),
            BridgeError::new("soul-revision-failed", "agent-bot staged no revision")
        );
        let mut elsewhere: Value = serde_json::from_str(PREPARE).unwrap();
        elsewhere["staging"] =
            json!("/Users/me/Desktop/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb");
        assert_eq!(
            prepared_revision(&elsewhere).unwrap_err().code,
            "soul-revision-invalid"
        );
    }

    #[test]
    fn accepts_only_a_staging_of_the_engines_shape() {
        assert_eq!(
            staging_path(STAGING).unwrap(),
            std::path::Path::new(STAGING)
        );
        for bad in [
            "",
            "revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb",
            "/Users/me/souls/example.soul/.soul-state/tmp/revision-44430c4f",
            "/Users/me/souls/example.soul/.soul-state/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eg",
            "/Users/me/souls/example.soul/.soul-state/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb",
            "/Users/me/souls/example.soul/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb",
            "/Users/me/souls/example.soul/.soul-state/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb/..",
            "/Users/me/souls/example.soul/.soul-state/tmp/edit.soul",
            "/Users/me/souls/example.soul/.soul-state/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb\n",
        ] {
            assert_eq!(staging_path(bad).unwrap_err().code, "soul-revision-invalid", "{bad:?}");
        }
    }

    #[test]
    fn discards_through_the_engine() {
        assert_eq!(
            discard_args(std::path::Path::new(STAGING)),
            vec![
                "soul",
                "revision",
                "prepare",
                "--discard",
                STAGING,
                "--json"
            ]
        );
        assert_eq!(
            parse_revision_discard(format!("{{\"discarded\":\"{STAGING}\"}}\n").as_bytes(), b"")
                .unwrap()["discarded"],
            STAGING
        );
        assert_eq!(
            parse_revision_discard(
                b"",
                b"agent-bot soul revision: staging-missing: no staging directory at /Users/me/nope\n"
            )
            .unwrap_err(),
            BridgeError::new("staging-missing", "no staging directory at /Users/me/nope")
        );
        assert_eq!(
            parse_revision_discard(
                b"",
                b"agent-bot soul revision: staging-not-temp: refusing to remove /Users/me/x: only a revision-<uuid> directory under a soul's .soul-state/tmp/ is staging\n"
            )
            .unwrap_err()
            .code,
            "staging-not-temp"
        );
    }

    #[test]
    fn keeps_a_prepared_staging_for_one_save_or_cancel() {
        let prepared = PreparedRevisions::default();
        let record = prepared_revision(&serde_json::from_str(PREPARE).unwrap()).unwrap();
        prepared.insert(record.clone());
        assert_eq!(prepared.take(std::path::Path::new(STAGING)), Some(record));
        assert_eq!(prepared.take(std::path::Path::new(STAGING)), None);
    }

    /// A staging as the engine leaves it: the rows above, on disk.
    fn staging() -> (RevisionCopy, std::path::PathBuf) {
        let temp = RevisionCopy::new().unwrap();
        let root = temp
            .path()
            .join("revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb");
        let write = |path: &str, text: &[u8]| {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        };
        write(
            "soul.json",
            b"{\"formatVersion\":2,\"name\":\"Example\",\"description\":\"Test\",\"revision\":\"sha256:aa\",\"parentRevision\":null,\"x-unknown\":1}\n",
        );
        write(".mcp.json", b"{}\n");
        write("AGENTS.md", b"Original instructions\n");
        write("bin/run", b"#!/bin/sh\necho old\n");
        write("policy.json", b"{\"mode\":\"ask\"}\n");
        write("skills/hello/SKILL.md", b"---\nname: hello\n---\nhi\n");
        write("skills/hello/diagram.png", &[0x89, 0x50, 0, 255]);
        write("soul.md", b"# Example\n");
        (temp, root)
    }

    fn rows() -> Vec<StagedFile> {
        prepared_revision(&serde_json::from_str(PREPARE).unwrap())
            .unwrap()
            .files
    }

    fn edit(files: &[(&str, &str)]) -> SoulRevisionEdit {
        SoulRevisionEdit {
            files: files
                .iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect(),
            ..Default::default()
        }
    }

    fn profile() -> Value {
        json!({
            "agentId": "agent_p",
            "profile": {"name": "example", "package": "/Users/me/souls/example.soul", "revision": "sha256:aa"},
            "skills": [{"name": "hello", "source": "soul", "enabled": true}],
            "files": [],
        })
    }

    #[test]
    fn writes_what_the_engine_marks_editable_text_and_the_manifest() {
        let (_temp, root) = staging();
        let mut request = edit(&[
            ("AGENTS.md", "# New\n"),
            ("policy.json", "{\"mode\":\"allow\"}\n"),
            ("skills/hello/SKILL.md", "x"),
        ]);
        request.name = Some(" Nova ".into());
        request.role = Some("Reviewer".into());
        request.skills = Some(json!({ "disabled": ["hello"] }));
        let manifest = check_manifest_edit(&request, &profile()).unwrap();
        write_revision_edit(&root, &request, &manifest, &rows()).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "# New\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("policy.json")).unwrap(),
            "{\"mode\":\"allow\"}\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("skills/hello/SKILL.md")).unwrap(),
            "x"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("soul.md")).unwrap(),
            "# Example\n"
        );
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("soul.json")).unwrap())
                .unwrap();
        assert_eq!(written["name"], "Nova");
        assert_eq!(written["description"], "Test");
        assert_eq!(written["role"], "Reviewer");
        assert_eq!(written["skills"], json!({ "disabled": ["hello"] }));
        assert_eq!(written["revision"], "sha256:aa");
        assert_eq!(written["x-unknown"], 1);
    }

    #[test]
    fn refuses_what_the_engine_marks_read_only_or_binary_before_writing() {
        let (_temp, root) = staging();
        for (path, why) in [
            ("bin/run", "editable false"),
            (".mcp.json", "generated"),
            ("soul.json", "manifest"),
            ("skills/hello/diagram.png", "not text"),
            ("CLAUDE.md", "not staged"),
            ("../AGENTS.md", "traversal"),
            ("", "empty"),
        ] {
            let request = edit(&[(path, "x"), ("AGENTS.md", "changed")]);
            let error = check_manifest_edit(&request, &profile())
                .and_then(|manifest| write_revision_edit(&root, &request, &manifest, &rows()))
                .unwrap_err();
            assert_eq!(error.code, "soul-revision-invalid", "{path}: {why}");
        }
        // Nothing was written on the way to the refusal.
        assert_eq!(
            std::fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "Original instructions\n"
        );
        // A staged path that is a link on disk is refused at write time.
        #[cfg(unix)]
        {
            std::fs::remove_file(root.join("soul.md")).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", root.join("soul.md")).unwrap();
            let request = edit(&[("soul.md", "x")]);
            let manifest = check_manifest_edit(&request, &profile()).unwrap();
            assert!(write_revision_edit(&root, &request, &manifest, &rows())
                .unwrap_err()
                .message
                .contains("link"));
        }
    }

    #[test]
    fn checks_the_manifest_fields_before_anything_is_staged() {
        let mut blank = edit(&[]);
        blank.name = Some("  ".into());
        assert_eq!(
            check_manifest_edit(&blank, &profile()).unwrap_err().code,
            "soul-revision-invalid"
        );
        let mut multiline = edit(&[]);
        multiline.name = Some("a\nb".into());
        assert!(check_manifest_edit(&multiline, &profile()).is_err());
        for bad in [
            json!({ "hue": 360 }),
            json!({ "hue": -1 }),
            json!({ "hue": 1.5 }),
            json!({ "hue": "x" }),
            json!({}),
            json!({ "hue": 1, "extra": true }),
            json!("red"),
        ] {
            let mut colour = edit(&[]);
            colour.appearance = Some(bad);
            assert_eq!(
                check_manifest_edit(&colour, &profile()).unwrap_err().code,
                "soul-revision-invalid"
            );
        }
        let big = "x".repeat(MAX_EDIT_BYTES + 1);
        assert!(check_manifest_edit(&edit(&[("AGENTS.md", &big)]), &profile()).is_err());
        // A role of at most 60 characters, cleared by an empty one.
        let mut long = edit(&[]);
        long.role = Some("r".repeat(61));
        assert!(check_manifest_edit(&long, &profile()).is_err());
        let mut clear = edit(&[]);
        clear.role = Some("  ".into());
        assert_eq!(
            check_manifest_edit(&clear, &profile()).unwrap().role,
            Some(None)
        );
        let mut sixty = edit(&[]);
        sixty.role = Some("r".repeat(60));
        assert!(check_manifest_edit(&sixty, &profile()).is_ok());
        // Skills: names the package has, deduplicated and sorted; nothing else.
        let mut off = edit(&[]);
        off.skills = Some(json!({ "disabled": ["hello", "hello"] }));
        assert_eq!(
            check_manifest_edit(&off, &profile()).unwrap().skills,
            Some(vec!["hello".to_string()])
        );
        for bad in [
            json!({ "disabled": ["ship"] }),
            json!({ "disabled": "hello" }),
            json!({ "disabled": ["hello"], "other": 1 }),
            json!(["hello"]),
            json!(null),
        ] {
            let mut wrong = edit(&[]);
            wrong.skills = Some(bad);
            assert_eq!(
                check_manifest_edit(&wrong, &profile()).unwrap_err().code,
                "soul-revision-invalid"
            );
        }
        let mut nothing = edit(&[]);
        assert!(nothing.is_empty());
        nothing.appearance = Some(Value::Null);
        assert!(!nothing.is_empty());
        assert_eq!(
            check_manifest_edit(&nothing, &profile())
                .unwrap()
                .appearance,
            Some(None)
        );
    }

    #[test]
    fn removes_manifest_keys_the_edit_clears() {
        let (_temp, root) = staging();
        let mut set = edit(&[]);
        set.appearance = Some(json!({ "hue": 210 }));
        set.role = Some("Lead".into());
        set.skills = Some(json!({ "disabled": ["hello"] }));
        let manifest = check_manifest_edit(&set, &profile()).unwrap();
        write_revision_edit(&root, &set, &manifest, &rows()).unwrap();
        let read = || -> Value {
            serde_json::from_str(&std::fs::read_to_string(root.join("soul.json")).unwrap()).unwrap()
        };
        assert_eq!(read()["appearance"], json!({ "hue": 210 }));
        assert_eq!(read()["role"], "Lead");
        let mut clear = edit(&[]);
        clear.appearance = Some(Value::Null);
        clear.role = Some("".into());
        clear.skills = Some(json!({ "disabled": [] }));
        let manifest = check_manifest_edit(&clear, &profile()).unwrap();
        write_revision_edit(&root, &clear, &manifest, &rows()).unwrap();
        let cleared = read();
        assert!(cleared.get("appearance").is_none());
        assert!(cleared.get("role").is_none());
        assert!(cleared.get("skills").is_none());
        assert_eq!(cleared["name"], "Example");
    }

    #[test]
    fn builds_revision_edit_arguments() {
        let staging = std::path::Path::new(STAGING);
        assert_eq!(
            soul_revision_edit_args("agent_p", staging, "Edited in GeniusBar").unwrap(),
            vec![
                "soul",
                "revision",
                "edit",
                "agent_p",
                STAGING,
                "Edited in GeniusBar",
                "--apply"
            ]
        );
        assert!(soul_revision_edit_args("luna", staging, "r").is_err());
        assert!(
            soul_revision_edit_args("agent_p", std::path::Path::new("edit.soul"), "r").is_err()
        );
        assert_eq!(revision_reason("  Tidy up  ").unwrap(), "Tidy up");
        for reason in ["", " ", "--principal-stdin", "a\nb", &"r".repeat(201)] {
            assert_eq!(
                revision_reason(reason).unwrap_err().code,
                "soul-revision-invalid"
            );
        }
    }

    #[test]
    fn parses_the_record_or_the_refusal() {
        let record = parse_soul_revision_edit(
            b"{\"schemaVersion\":1,\"kind\":\"revision\",\"revision\":\"sha256:bb\",\"parentRevision\":\"sha256:aa\",\"author\":\"user\",\"reason\":\"r\",\"authorization\":{\"method\":\"presence\",\"via\":\"agent-bot-keyd\"}}\n",
            b"",
        )
        .unwrap();
        assert_eq!(record["revision"], "sha256:bb");
        assert_eq!(
            parse_soul_revision_edit(
                b"",
                b"agent-bot soul revision: owner-credential-required: owner consent requires an interactive terminal; --yes cannot approve\n"
            ),
            Err(BridgeError::new(
                "owner-credential-required",
                "owner consent requires an interactive terminal; --yes cannot approve"
            ))
        );
        assert_eq!(
            parse_soul_revision_edit(
                b"",
                b"agent-bot soul revision: stale proposal or edit: create a new revision from the current head\n"
            )
            .unwrap_err()
            .code,
            "soul-revision-stale"
        );
        assert_eq!(
            parse_soul_revision_edit(
                b"",
                b"agent-bot soul revision: adopt a starting package before editing or proposing\n"
            ),
            Err(BridgeError::new(
                "soul-revision-failed",
                "adopt a starting package before editing or proposing"
            ))
        );
        assert_eq!(
            parse_soul_revision_edit(b"{}\n", b"").unwrap_err().message,
            "agent-bot recorded no revision"
        );
    }
}

/// The fallback for a bundle without `revision-prepare` (`legacy_prepare`):
/// the app's own copy and rules, as before #268.
#[cfg(test)]
mod legacy_prepare_tests {
    use super::legacy_prepare::{self, RevisionCopy};
    use super::*;

    /// A scratch package with soul.json, AGENTS.md, soul.md, a skill, a
    /// generated CLAUDE.md and working state; removed when dropped.
    struct Fixture {
        root: RevisionCopy,
    }

    impl Fixture {
        fn new() -> Self {
            let root = RevisionCopy::new().unwrap();
            let package = root.path().join("Luna.soul");
            let write = |path: &str, text: &str| {
                let file = package.join(path);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, text).unwrap();
            };
            write(
                "soul.json",
                "{\"formatVersion\":2,\"name\":\"Luna\",\"description\":\"Leads.\",\"revision\":\"sha256:aa\",\"parentRevision\":null,\"x-unknown\":1}\n",
            );
            write("AGENTS.md", "# Agents\n");
            write("soul.md", "# Luna\n");
            write("skills/triage/SKILL.md", "---\nname: triage\n---\n");
            write("CLAUDE.md", "# generated\n");
            write(
                "notes.md",
                &format!("{}\nbuilt\n", legacy_prepare::marker()),
            );
            write(".soul-state/home/token", "secret");
            write("worktrees/w/file", "work");
            Self { root }
        }

        fn package(&self) -> String {
            self.root.path().join("Luna.soul").display().to_string()
        }

        fn profile(&self) -> Value {
            json!({
                "agentId": "agent_p",
                "profile": {"name": "luna", "package": self.package(), "revision": "sha256:aa"},
                "skills": [
                    {"name": "review", "source": "sop", "enabled": true},
                    {"name": "triage", "source": "soul", "enabled": true},
                ],
                "files": [
                    {"path": "AGENTS.md", "kind": "context", "text": true, "size": 9},
                    {"path": "CLAUDE.md", "kind": "generated", "text": true},
                    {"path": ".claude/settings.json", "kind": "harness-settings", "text": true},
                    {"path": "notes.md", "kind": "context", "text": true},
                    {"path": "soul.json", "kind": "soul", "text": true},
                    {"path": "soul.md", "kind": "soul", "text": true},
                    {"path": "skills/triage/SKILL.md", "kind": "skill", "text": true},
                    {"path": "skills/triage/diagram.png", "kind": "skill", "text": false},
                    {"path": ".soul-state/home/AGENTS.md", "kind": "context", "text": true},
                ],
            })
        }
    }

    fn edit(files: &[(&str, &str)]) -> SoulRevisionEdit {
        SoulRevisionEdit {
            files: files
                .iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect(),
            ..Default::default()
        }
    }

    /// Stages, checks the marker and writes, as `legacy_prepare::edit` does
    /// before it calls agent-bot.
    fn prepare(
        fixture: &Fixture,
        expected: Option<&str>,
        request: &SoulRevisionEdit,
        temp: &std::path::Path,
    ) -> Result<(String, std::path::PathBuf), BridgeError> {
        let profile = fixture.profile();
        let manifest = check_manifest_edit(request, &profile)?;
        let (agent, copy) = legacy_prepare::stage(&profile, expected, temp)?;
        legacy_prepare::refuse_generated_marker(&copy, request)?;
        write_revision_edit(&copy, request, &manifest, &legacy_prepare::rows(&profile))?;
        Ok((agent, copy))
    }

    #[test]
    fn answers_the_inventory_in_the_engines_shape_with_no_staging() {
        let fixture = Fixture::new();
        let inventory = legacy_prepare::inventory(&fixture.profile());
        assert_eq!(inventory["schemaVersion"], 1);
        assert_eq!(inventory["agentId"], "agent_p");
        assert_eq!(inventory["staging"], Value::Null);
        assert_eq!(inventory["revision"], "sha256:aa");
        assert_eq!(inventory["soulDir"], fixture.package());
        let rows = inventory["files"].as_array().unwrap();
        let editable = |path: &str| {
            rows.iter()
                .find(|r| r["path"] == path)
                .map(|r| r["editable"] == true)
        };
        assert_eq!(editable("AGENTS.md"), Some(true));
        assert_eq!(editable("soul.md"), Some(true));
        assert_eq!(editable("skills/triage/SKILL.md"), Some(true));
        // Editable but not text: the dialog shows it, edits nothing.
        assert_eq!(editable("skills/triage/diagram.png"), Some(true));
        assert_eq!(
            rows.iter()
                .find(|r| r["path"] == "skills/triage/diagram.png")
                .unwrap()["text"],
            false
        );
        assert_eq!(editable("soul.json"), Some(false));
        assert_eq!(editable("CLAUDE.md"), Some(false));
        assert_eq!(editable(".claude/settings.json"), Some(false));
        assert_eq!(editable(".soul-state/home/AGENTS.md"), Some(false));
        assert_eq!(rows[0]["size"], 9);
        assert_eq!(rows[0]["kind"], "context");
        assert_eq!(rows[0]["classification"], Value::Null);
    }

    #[test]
    fn edits_a_private_copy_and_leaves_the_package_alone() {
        let fixture = Fixture::new();
        let temp = RevisionCopy::new().unwrap();
        let mut request = edit(&[("AGENTS.md", "# New\n"), ("skills/triage/SKILL.md", "x")]);
        request.name = Some(" Nova ".into());
        request.description = Some("Reviews.\nCarefully.".into());
        request.appearance = Some(json!({ "hue": 210 }));
        let (agent, copy) = prepare(&fixture, Some("sha256:aa"), &request, temp.path()).unwrap();
        assert_eq!(agent, "agent_p");
        assert!(copy.starts_with(temp.path()));
        assert_eq!(
            std::fs::read_to_string(copy.join("AGENTS.md")).unwrap(),
            "# New\n"
        );
        assert_eq!(
            std::fs::read_to_string(copy.join("skills/triage/SKILL.md")).unwrap(),
            "x"
        );
        assert_eq!(
            std::fs::read_to_string(copy.join("soul.md")).unwrap(),
            "# Luna\n"
        );
        let manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(copy.join("soul.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "Nova");
        assert_eq!(manifest["description"], "Reviews.\nCarefully.");
        assert_eq!(manifest["appearance"], json!({ "hue": 210 }));
        assert_eq!(manifest["revision"], "sha256:aa");
        assert_eq!(manifest["x-unknown"], 1);
        // Working state never reaches the copy.
        assert!(!copy.join(".soul-state").exists());
        assert!(!copy.join("worktrees").exists());
        // The soul's own package is untouched.
        let package = std::path::PathBuf::from(fixture.package());
        assert_eq!(
            std::fs::read_to_string(package.join("AGENTS.md")).unwrap(),
            "# Agents\n"
        );
        assert!(std::fs::read_to_string(package.join("soul.json"))
            .unwrap()
            .contains("\"Luna\""));
        let path = temp.path().to_path_buf();
        drop(temp);
        assert!(!path.exists());
    }

    #[test]
    fn refuses_paths_outside_the_editable_inventory_and_a_marker_file() {
        let fixture = Fixture::new();
        let temp = RevisionCopy::new().unwrap();
        for path in [
            "../AGENTS.md",
            "/etc/passwd",
            "skills/../soul.json",
            "./AGENTS.md",
            "skills\\triage",
            "soul.json",
            "CLAUDE.md",
            ".claude/settings.json",
            ".soul-state/home/AGENTS.md",
            "skills/triage/diagram.png",
            "policy.json",
            "",
        ] {
            assert_eq!(
                prepare(&fixture, None, &edit(&[(path, "x")]), temp.path())
                    .unwrap_err()
                    .code,
                "soul-revision-invalid",
                "{path}"
            );
        }
        let error = prepare(&fixture, None, &edit(&[("notes.md", "x")]), temp.path()).unwrap_err();
        assert_eq!(error.code, "soul-revision-invalid");
        assert!(error.message.contains("generated"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_in_the_package() {
        let fixture = Fixture::new();
        let package = std::path::PathBuf::from(fixture.package());
        std::os::unix::fs::symlink("/etc/hosts", package.join("skills/hosts")).unwrap();
        let temp = RevisionCopy::new().unwrap();
        let error = prepare(&fixture, None, &edit(&[("AGENTS.md", "x")]), temp.path()).unwrap_err();
        assert_eq!(error.code, "soul-revision-invalid");
        assert!(error.message.contains("link"));
    }

    #[test]
    fn refuses_a_moved_revision_and_a_missing_package() {
        let fixture = Fixture::new();
        let temp = RevisionCopy::new().unwrap();
        assert_eq!(
            prepare(
                &fixture,
                Some("sha256:bb"),
                &edit(&[("AGENTS.md", "x")]),
                temp.path()
            )
            .unwrap_err()
            .code,
            "soul-revision-stale"
        );
        let mut no_package = fixture.profile();
        no_package["profile"]["package"] = Value::Null;
        assert!(legacy_prepare::stage(&no_package, None, temp.path()).is_err());
    }
}

/// GitHub identities (#67), from agent-bot's managed Apps
/// (agent-bot-identity #373, `docs/identity-apps.md`): `identity apps list
/// --json` is offline and secret-free, `{schemaVersion: 1, apps: [...]}`.
/// With the `github-identity` add-on off the list is empty and every
/// mutation answers `identity-app-disabled`. Mutations are owner-gated by
/// agent-bot (its consent dialog, Touch ID); GeniusBar never asks itself.
/// Every parser here passes on only the documented fields, so nothing else
/// agent-bot or a provider printed reaches the web view.
#[tauri::command]
pub async fn identity_apps_list<R: Runtime>(app: AppHandle<R>) -> Result<Value, BridgeError> {
    let output = run_agent_bot(&app, identity_apps_list_args(), "identity-app-unavailable").await?;
    parse_identity_apps_list(&output.stdout, &output.stderr)
}

/// Connects an existing App: its ID and its private key, a file the owner
/// picks in the native open dialog or, with `pass_cli`, an item in the
/// owner's pass-cli vault that agent-bot restores itself. Only the path or
/// the item's name goes to agent-bot; the key is never read here.
/// `{id, slug, installUrl}`.
#[tauri::command]
pub async fn identity_app_connect<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    prompt: String,
    pass_cli: Option<String>,
) -> Result<Value, BridgeError> {
    identity_app_id(&id)?;
    let key = identity_key_source(pass_cli, prompt).await?;
    let args = identity_app_connect_args(&id, &key)?;
    let output = run_agent_bot(&app, args, "identity-app-unavailable").await?;
    parse_identity_app_result(&output.stdout, &output.stderr, false)
}

/// Rotates a managed App's key to a new one the owner downloaded from the
/// App's settings on github.com: a file picked in the native open dialog,
/// or a pass-cli item (`pass_cli`). `{id, slug, installUrl, retired}`;
/// `retired` is the old key's public fingerprint, which the owner must
/// still delete on github.com.
#[tauri::command]
pub async fn identity_app_rotate_key<R: Runtime>(
    app: AppHandle<R>,
    slug: String,
    prompt: String,
    pass_cli: Option<String>,
) -> Result<Value, BridgeError> {
    identity_app_slug(&slug)?;
    let key = identity_key_source(pass_cli, prompt).await?;
    let args = identity_app_rotate_args(&slug, &key)?;
    let output = run_agent_bot(&app, args, "identity-app-unavailable").await?;
    parse_identity_app_result(&output.stdout, &output.stderr, true)
}

/// Where a connect or rotation takes its key from: the pass-cli item when
/// one is named (checked before anything opens), else the file the owner
/// picks in the dialog.
async fn identity_key_source(
    pass_cli: Option<String>,
    prompt: String,
) -> Result<KeySource, BridgeError> {
    match pass_cli.filter(|item| !item.is_empty()) {
        Some(item) => {
            identity_pass_item(&item)?;
            Ok(KeySource::PassCli(item))
        }
        None => Ok(KeySource::File(pick_key_file(prompt).await?)),
    }
}

/// Assigns a managed App to a harness or a soul: `{slug, harness}` or
/// `{slug, soul}`.
#[tauri::command]
pub async fn identity_app_assign<R: Runtime>(
    app: AppHandle<R>,
    slug: String,
    harness: Option<String>,
    soul: Option<String>,
) -> Result<Value, BridgeError> {
    let args = identity_app_assign_args(&slug, harness.as_deref(), soul.as_deref())?;
    let output = run_agent_bot(&app, args, "identity-app-unavailable").await?;
    parse_identity_app_assign(&output.stdout, &output.stderr)
}

/// Forgets a managed App on this Mac (agent-bot-identity #554): its stored
/// key and its config record go; the App itself stays on github.com.
/// agent-bot refuses with `identity-app-assigned`, naming each harness and
/// soul that still uses it. `{slug, id, removed: {storeItem, configRecord}}`,
/// names only.
#[tauri::command]
pub async fn identity_app_remove<R: Runtime>(
    app: AppHandle<R>,
    slug: String,
) -> Result<Value, BridgeError> {
    let args = identity_app_remove_args(&slug)?;
    let output = run_agent_bot(&app, args, "identity-app-unavailable").await?;
    parse_identity_app_remove(&output.stdout, &output.stderr)
}

/// The owner's switch for an agent-bot add-on (agent-bot-identity #554):
/// `identity addon github-identity on|off`, which works while the add-on is
/// off and is owner-gated like every App change. `{addon, enabled, changed}`.
#[tauri::command]
pub async fn identity_addon_set<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    enabled: bool,
) -> Result<Value, BridgeError> {
    let args = identity_addon_args(&name, enabled)?;
    let output = run_agent_bot(&app, args, "identity-app-unavailable").await?;
    parse_identity_addon(&output.stdout, &output.stderr)
}

/// Starts GitHub's manifest flow with `identity app create --manifest
/// --json`: agent-bot asks the owner, opens a ten-minute loopback listener
/// and prints `{status: "pending", localUrl}`; GitHub's answer later brings
/// `{id, slug, installUrl}` or an error. The process runs detached, in its
/// own session with its output in files under the app's local data dir, so
/// a create outlives GeniusBar and is found again at the next launch
/// (`IdentityJobs::reattach`). This waits for the pending line and returns
/// `{handle, localUrl}`; `identity_app_create_status` reports the rest.
#[tauri::command]
pub async fn identity_app_create<R: Runtime>(
    app: AppHandle<R>,
    jobs: State<'_, IdentityJobs>,
    name: Option<String>,
    org: Option<String>,
) -> Result<Value, BridgeError> {
    let args = identity_app_create_args(name.as_deref(), org.as_deref())?;
    let handle = jobs.start(&app, args)?;
    // agent-bot asks the owner before it listens, so the first line waits
    // on that answer; a dialog left alone gives up with the listener.
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        match jobs.state(handle)? {
            CreateState::Pending(Some(url)) => {
                return Ok(json!({ "handle": handle, "localUrl": url }))
            }
            // Both lines were there at the first look: nothing to open, and
            // the status read brings the result.
            CreateState::Complete(_) => return Ok(json!({ "handle": handle, "localUrl": "" })),
            CreateState::Failed(error) => {
                jobs.cancel(handle);
                return Err(error);
            }
            CreateState::Pending(None) if Instant::now() >= deadline => {
                jobs.cancel(handle);
                return Err(BridgeError::new(
                    "identity-app-timeout",
                    "agent-bot did not start App creation",
                ));
            }
            CreateState::Pending(None) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

/// Where a create started by `identity_app_create`, or found again at
/// launch, stands: `{status: "pending", localUrl}`, `{status: "complete",
/// result: {id, slug, installUrl}}` or `{status: "failed", error: {code,
/// message}}`; `identity-app-interrupted` when its process is gone without
/// an answer.
#[tauri::command]
pub fn identity_app_create_status(
    jobs: State<'_, IdentityJobs>,
    handle: u64,
) -> Result<Value, BridgeError> {
    jobs.state(handle).map(|state| state.to_json())
}

/// The creates still waiting for GitHub, including those a previous launch
/// started: `[{handle, localUrl}]`, so the UI can take them up again.
#[tauri::command]
pub fn identity_app_create_pending(jobs: State<'_, IdentityJobs>) -> Value {
    Value::Array(jobs.pending())
}

/// Stops a create that is still waiting for GitHub: agent-bot's listener
/// closes with its process, and the record goes.
#[tauri::command]
pub fn identity_app_create_cancel(jobs: State<'_, IdentityJobs>, handle: u64) {
    jobs.cancel(handle);
}

/// Opens the create flow's loopback page or a GitHub App page in the
/// owner's browser with the system opener. Nothing else is opened.
#[tauri::command]
pub async fn identity_app_open(url: String) -> Result<(), BridgeError> {
    if !identity_url_allowed(&url) {
        return Err(BridgeError::new(
            "identity-app-invalid",
            "only the App creation page or github.com can be opened",
        ));
    }
    let opened = tauri::async_runtime::spawn_blocking(move || open_in_browser(url))
        .await
        .map_err(|e| BridgeError::new("identity-app-open-failed", &e.to_string()))?
        .map_err(|e| BridgeError::new("identity-app-open-failed", &e.to_string()))?;
    if opened {
        Ok(())
    } else {
        Err(BridgeError::new(
            "identity-app-open-failed",
            "the browser could not be opened",
        ))
    }
}

/// Hands an allow-listed URL to the system opener; true when it took it.
#[cfg(unix)]
fn open_in_browser(url: String) -> std::io::Result<bool> {
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map(|status| status.success())
}

/// The shell plugin's own opener (the `open` crate): PowerShell's
/// `Start-Process` with the URL in an environment variable, so no `cmd`
/// ever parses it.
#[cfg(windows)]
fn open_in_browser(url: String) -> std::io::Result<bool> {
    open::that(url).map(|()| true)
}

/// The creates this launch started or found again, by handle. Each is an
/// `agent-bot identity app create` running on its own, known by its files
/// under `<app_local_data_dir>/identity-create/`: `<id>.json` (`{pid,
/// startedAt}`), `<id>.out` (its stdout, the lines `parse_create_line`
/// reads) and `<id>.err`. Nothing secret is in them: agent-bot prints the
/// page, then the App's public result or an error.
#[derive(Default)]
pub struct IdentityJobs {
    next: AtomicU64,
    jobs: Mutex<HashMap<u64, CreateRecord>>,
}

/// A create's process and files.
#[derive(Debug, Clone)]
struct CreateRecord {
    pid: u32,
    json: std::path::PathBuf,
    out: std::path::PathBuf,
    err: std::path::PathBuf,
}

/// What a create's files say.
#[derive(Debug, PartialEq)]
enum CreateState {
    /// Waiting: on the owner's answer (no page yet), then on GitHub.
    Pending(Option<String>),
    Complete(Value),
    Failed(BridgeError),
}

/// Records older than this are forgotten at launch.
const CREATE_RECORD_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
/// agent-bot's listener gives up after ten minutes, so a pending record
/// quiet for longer is not a create any more, whatever its pid now runs.
const CREATE_PENDING_LIMIT: Duration = Duration::from_secs(15 * 60);

impl CreateState {
    fn to_json(&self) -> Value {
        match self {
            CreateState::Pending(url) => json!({ "status": "pending", "localUrl": url }),
            CreateState::Complete(result) => json!({ "status": "complete", "result": result }),
            CreateState::Failed(error) => json!({
                "status": "failed",
                "error": { "code": error.code, "message": error.message },
            }),
        }
    }
}

impl CreateRecord {
    fn new(dir: &std::path::Path, id: &str, pid: u32) -> Self {
        Self {
            pid,
            json: dir.join(format!("{id}.json")),
            out: dir.join(format!("{id}.out")),
            err: dir.join(format!("{id}.err")),
        }
    }

    /// A record's `pid` from its `.json`; None when it is not one.
    fn read(dir: &std::path::Path, id: &str) -> Option<Self> {
        let json = dir.join(format!("{id}.json"));
        let record: Value = serde_json::from_slice(&std::fs::read(json).ok()?).ok()?;
        let pid = u32::try_from(record.get("pid")?.as_u64()?).ok()?;
        Some(Self::new(dir, id, pid))
    }

    fn state(&self) -> CreateState {
        let stdout = std::fs::read(&self.out).unwrap_or_default();
        let stderr = std::fs::read(&self.err).unwrap_or_default();
        let alive = pid_alive(self.pid) && file_age(&self.out) < CREATE_PENDING_LIMIT;
        create_state(&stdout, &stderr, alive)
    }

    /// Ends the create's process, if the pid still runs an `agent-bot`
    /// create: a pid from a record can have been reused since, and a signal
    /// to someone else's process is worse than a listener left to time out.
    fn kill(&self) {
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(self.pid) {
            if pid_alive(self.pid) && pid_runs_create(self.pid) {
                // SAFETY: a plain signal to a pid this app recorded and checked.
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
        }
        #[cfg(windows)]
        if pid_alive(self.pid) && pid_runs_create(self.pid) {
            terminate_process(self.pid);
        }
    }

    fn remove(&self) {
        for path in [&self.json, &self.out, &self.err] {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl IdentityJobs {
    /// Spawns the create and registers it. Fails `identity-app-unavailable`
    /// when the sidecar or the record directory is not there.
    fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        args: Vec<std::ffi::OsString>,
    ) -> Result<u64, BridgeError> {
        let unavailable = |e: String| BridgeError::new("identity-app-unavailable", &e);
        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| unavailable(e.to_string()))?;
        let mut argv: Vec<std::ffi::OsString> = vec![resources
            .join("components")
            .join("agent-bot")
            .join("agent-bot.mjs")
            .into_os_string()];
        argv.extend(args);
        let dir = create_record_dir(app).map_err(unavailable)?;
        let record = spawn_create(&dir, argv).map_err(unavailable)?;
        Ok(self.register(record))
    }

    fn register(&self, record: CreateRecord) -> u64 {
        let handle = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.jobs.lock().unwrap().insert(handle, record);
        handle
    }

    fn record(&self, handle: u64) -> Result<CreateRecord, BridgeError> {
        self.jobs
            .lock()
            .unwrap()
            .get(&handle)
            .cloned()
            .ok_or_else(|| {
                BridgeError::new(
                    "identity-app-job-not-found",
                    "this App creation is no longer running",
                )
            })
    }

    fn state(&self, handle: u64) -> Result<CreateState, BridgeError> {
        Ok(self.record(handle)?.state())
    }

    fn cancel(&self, handle: u64) {
        if let Some(record) = self.jobs.lock().unwrap().remove(&handle) {
            record.kill();
            record.remove();
        }
    }

    /// `[{handle, localUrl}]` for the creates waiting on GitHub.
    fn pending(&self) -> Vec<Value> {
        let jobs = self.jobs.lock().unwrap();
        let mut handles: Vec<&u64> = jobs.keys().collect();
        handles.sort();
        handles
            .into_iter()
            .filter_map(|handle| match jobs[handle].state() {
                CreateState::Pending(Some(url)) => {
                    Some(json!({ "handle": handle, "localUrl": url }))
                }
                _ => None,
            })
            .collect()
    }

    /// Takes up the creates a previous launch left in the record
    /// directory: one still running, or holding GitHub's answer, is
    /// registered again (`identity_app_create_pending` offers the waiting
    /// ones to the UI); one interrupted, or older than a day, is deleted,
    /// as is any stray file that old.
    pub fn reattach<R: Runtime>(app: &AppHandle<R>) {
        let Ok(dir) = create_record_dir(app) else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        let jobs = app.state::<IdentityJobs>();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(id) = name.strip_suffix(".json") else {
                if file_age(&path) >= CREATE_RECORD_LIFETIME {
                    let _ = std::fs::remove_file(&path);
                }
                continue;
            };
            let record = match CreateRecord::read(&dir, id) {
                Some(record) if file_age(&record.json) < CREATE_RECORD_LIFETIME => record,
                _ => {
                    CreateRecord::new(&dir, id, 0).remove();
                    continue;
                }
            };
            match record.state() {
                CreateState::Failed(error) if error.code == "identity-app-interrupted" => {
                    record.remove();
                }
                _ => {
                    jobs.register(record);
                }
            }
        }
    }
}

fn create_record_dir<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("identity-create");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The bundled Node, beside the app executable, where the shell plugin's
/// `sidecar("node")` finds it.
fn node_sidecar() -> Result<std::path::PathBuf, String> {
    let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "the app executable has no directory".to_string())?;
    // Under `cargo test` the executable sits in `deps`, as the shell plugin allows for.
    let dir = if dir.ends_with("deps") {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    // Tauri places the sidecar beside the exe as `node.exe` on Windows.
    Ok(dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
}

/// Runs `node argv` in its own session, its output in the record's files,
/// and writes the record. Quitting GeniusBar leaves it running.
fn spawn_create(
    dir: &std::path::Path,
    argv: Vec<std::ffi::OsString>,
) -> Result<CreateRecord, String> {
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos()
        .to_string();
    let mut record = CreateRecord::new(dir, &id, 0);
    let open = |path: &std::path::Path| {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        // The record directory is the user's own on Windows (ADR-0046):
        // no mode to set.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path).map_err(|e| e.to_string())
    };
    let out = open(&record.out)?;
    let err = open(&record.err)?;
    let mut command = std::process::Command::new(node_sidecar()?);
    command
        .args(argv)
        .envs(HOST_ENV.iter().copied())
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err);
    // SAFETY: setsid only, between fork and exec.
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    // Its own process group with no console, so quitting GeniusBar (or a
    // Ctrl-C in a console that started it) leaves the create running.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    let mut child = command.spawn().map_err(|e| {
        record.remove();
        e.to_string()
    })?;
    record.pid = child.id();
    // Reaped when it ends, so a finished create is no zombie that still
    // answers `kill(pid, 0)`.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let started = iso_time(std::time::SystemTime::now());
    std::fs::write(
        &record.json,
        json!({ "pid": record.pid, "startedAt": started }).to_string(),
    )
    .map_err(|e| {
        record.kill();
        record.remove();
        e.to_string()
    })?;
    Ok(record)
}

/// Whether `pid` is a process: signal 0 touches nothing, and EPERM says it
/// is there and someone else's.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 to a pid, which sends nothing.
    let sent = unsafe { libc::kill(pid, 0) };
    sent == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether `pid` is a process: a query-only handle whose exit code is
/// still `STILL_ACTIVE`, and access denied says it is there and someone
/// else's.
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    // SAFETY: a query-only handle to a pid, closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let known = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        known && code == STILL_ACTIVE as u32
    }
}

/// Ends `pid`, which `CreateRecord::kill` has checked still runs the create.
#[cfg(windows)]
fn terminate_process(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: a terminate-only handle to a pid this app recorded and
    // checked, closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

/// Whether `pid`'s command line is an `agent-bot identity app create`, as
/// `ps` reports it; false for any other process, or when `ps` cannot say.
#[cfg(unix)]
fn pid_runs_create(pid: u32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .is_some_and(|command| {
            command.contains("agent-bot.mjs") && command.contains(" identity app create")
        })
}

/// The same question through `Get-CimInstance Win32_Process`, the stock
/// tool that prints a command line (`tasklist` does not; `wmic` is gone).
/// `pid` is a number, so nothing of it is script text.
#[cfg(windows)]
fn pid_runs_create(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"
        ))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .is_some_and(|command| {
            command.contains("agent-bot.mjs") && command.contains(" identity app create")
        })
}

/// How long ago a file was last written; zero when it is not there.
fn file_age(path: &std::path::Path) -> Duration {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .unwrap_or_default()
}

/// What a create's output says: the page from its pending line while its
/// process is there, GitHub's result or agent-bot's error once printed, and
/// `identity-app-interrupted` when the process is gone without one. Before
/// the pending line, agent-bot's last word on stderr (a usage error) is the
/// reason instead.
fn create_state(stdout: &[u8], stderr: &[u8], alive: bool) -> CreateState {
    let mut pending = None;
    for line in stdout.split(|b| *b == b'\n') {
        match parse_create_line(line) {
            CreateLine::Pending(url) => pending = Some(url),
            CreateLine::Done(result) => return CreateState::Complete(result),
            CreateLine::Failed(error) => return CreateState::Failed(error),
            CreateLine::Other => {}
        }
    }
    if alive {
        return CreateState::Pending(pending);
    }
    let message = last_line(stderr);
    let message = message.strip_prefix("agent-bot: ").unwrap_or(&message);
    if pending.is_none() && !message.is_empty() {
        let error = identity_error(Err(BridgeError::new("identity-app-failed", message)));
        return CreateState::Failed(error.unwrap_err());
    }
    CreateState::Failed(BridgeError::new(
        "identity-app-interrupted",
        "GeniusBar or agent-bot stopped before GitHub answered",
    ))
}

/// `2026-10-07T12:34:56Z` for a time (the record's `startedAt`).
fn iso_time(time: std::time::SystemTime) -> String {
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (h, m, s) = ((secs % 86_400) / 3_600, (secs % 3_600) / 60, secs % 60);
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Lets the owner pick a private key file in the native open dialog.
/// `prompt` goes to the dialog script as an argument, never as script text.
async fn pick_key_file(prompt: String) -> Result<String, BridgeError> {
    let output = tauri::async_runtime::spawn_blocking(move || key_file_dialog(prompt))
        .await
        .map_err(|e| BridgeError::new("identity-app-key-unavailable", &e.to_string()))?
        .map_err(|e| BridgeError::new("identity-app-key-unavailable", &e.to_string()))?;
    picked_key_file(output.status.success(), &output.stdout, &output.stderr)
}

/// AppleScript's `choose file`, filtered to `.pem`.
#[cfg(unix)]
fn key_file_dialog(prompt: String) -> std::io::Result<std::process::Output> {
    std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "POSIX path of (choose file with prompt (item 1 of argv) of type {\"pem\"})",
            "-e",
            "end run",
        ])
        .arg(prompt)
        .output()
}

/// The Windows dialog: `System.Windows.Forms.OpenFileDialog` filtered to
/// `.pem`, the chosen path on stdout, and on cancel the `-128` line
/// AppleScript prints, so `picked_key_file` reads both the same way.
#[cfg(windows)]
const KEY_FILE_DIALOG_PS1: &str = r#"Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = [string]$args[0]
$dialog.Filter = 'Private key (*.pem)|*.pem'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($dialog.FileName)
    exit 0
}
[Console]::Error.WriteLine('User canceled. (-128)')
exit 1
"#;

/// PowerShell runs the script from a file in the user's own temp
/// directory, so the prompt is `-File`'s argument (`$args[0]`), never
/// script text (`-Command` would splice it in).
#[cfg(windows)]
fn key_file_dialog(prompt: String) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    let script =
        std::env::temp_dir().join(format!("geniusbar-pick-key-{}.ps1", std::process::id()));
    std::fs::write(&script, KEY_FILE_DIALOG_PS1)?;
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        .arg(prompt)
        .stdin(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = std::fs::remove_file(&script);
    output
}

/// The chosen path, or `identity-app-cancelled` when the owner closed the
/// dialog (AppleScript error -128, which the Windows script repeats).
fn picked_key_file(ok: bool, stdout: &[u8], stderr: &[u8]) -> Result<String, BridgeError> {
    let path = last_line(stdout);
    if ok && std::path::Path::new(&path).is_absolute() {
        return Ok(path);
    }
    if last_line(stderr).contains("-128") {
        return Err(BridgeError::new(
            "identity-app-cancelled",
            "no key file was chosen",
        ));
    }
    Err(BridgeError::new(
        "identity-app-key-unavailable",
        "the key file could not be chosen",
    ))
}

fn identity_url_allowed(url: &str) -> bool {
    let loopback = url.strip_prefix("http://127.0.0.1:").is_some_and(|rest| {
        rest.split(['/', '?'])
            .next()
            .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
    });
    let github = url.starts_with("https://github.com/");
    (loopback || github) && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// agent-bot's App slug rule, `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.
fn valid_identity_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    let edge = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|b| edge(b) || *b == b'-')
}

fn identity_invalid(message: &str) -> BridgeError {
    BridgeError::new("identity-app-invalid", message)
}

fn identity_app_slug(slug: &str) -> Result<(), BridgeError> {
    if valid_identity_slug(slug) {
        Ok(())
    } else {
        Err(identity_invalid("a valid App slug is required"))
    }
}

fn identity_app_id(id: &str) -> Result<(), BridgeError> {
    if !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(identity_invalid("the App ID is a number"))
    }
}

fn identity_key_path(path: &str) -> Result<(), BridgeError> {
    if path.starts_with('/') && !path.contains('\0') {
        Ok(())
    } else {
        Err(identity_invalid("the key file must be an absolute path"))
    }
}

/// A pass-cli item's name, as agent-bot's `identity-apps.mjs` `slug()`
/// takes it: the App slug rule, so nothing option-shaped gets through.
fn identity_pass_item(item: &str) -> Result<(), BridgeError> {
    if valid_identity_slug(item) {
        Ok(())
    } else {
        Err(identity_invalid(
            "the pass-cli item is a lowercase name of letters, digits and -",
        ))
    }
}

/// Where a connect or rotation takes its key from: `--key-file PATH`, a
/// file the owner picked, or `--pass-cli ITEM`, an item in the owner's
/// pass-cli vault that agent-bot restores itself.
#[derive(Debug, PartialEq)]
enum KeySource {
    File(String),
    PassCli(String),
}

impl KeySource {
    fn args(&self) -> Result<[std::ffi::OsString; 2], BridgeError> {
        match self {
            KeySource::File(path) => {
                identity_key_path(path)?;
                Ok(["--key-file".into(), path.into()])
            }
            KeySource::PassCli(item) => {
                identity_pass_item(item)?;
                Ok(["--pass-cli".into(), item.into()])
            }
        }
    }
}

fn identity_apps_list_args() -> Vec<std::ffi::OsString> {
    vec![
        "identity".into(),
        "apps".into(),
        "list".into(),
        "--json".into(),
    ]
}

fn identity_app_create_args(
    name: Option<&str>,
    org: Option<&str>,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    let mut args: Vec<std::ffi::OsString> = vec![
        "identity".into(),
        "app".into(),
        "create".into(),
        "--manifest".into(),
    ];
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        if name.starts_with('-')
            || name.chars().count() > 100
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
        {
            return Err(identity_invalid(
                "the App name uses letters, digits, spaces, dots, _ and -",
            ));
        }
        args.push("--name".into());
        args.push(name.into());
    }
    if let Some(org) = org.filter(|o| !o.is_empty()) {
        if !valid_identity_slug(org) {
            return Err(identity_invalid("the organization is a GitHub login"));
        }
        args.push("--org".into());
        args.push(org.into());
    }
    args.push("--json".into());
    Ok(args)
}

fn identity_app_connect_args(
    id: &str,
    key: &KeySource,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    identity_app_id(id)?;
    let [flag, value] = key.args()?;
    Ok(vec![
        "identity".into(),
        "app".into(),
        "connect".into(),
        "--id".into(),
        id.into(),
        flag,
        value,
        "--json".into(),
    ])
}

fn identity_app_rotate_args(
    slug: &str,
    key: &KeySource,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    identity_app_slug(slug)?;
    let [flag, value] = key.args()?;
    Ok(vec![
        "identity".into(),
        "app".into(),
        "rotate-key".into(),
        slug.into(),
        flag,
        value,
        "--json".into(),
    ])
}

fn identity_app_assign_args(
    slug: &str,
    harness: Option<&str>,
    soul: Option<&str>,
) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    identity_app_slug(slug)?;
    let target = |flag: &str, value: &str| -> Result<[std::ffi::OsString; 2], BridgeError> {
        if value.is_empty() || value.starts_with('-') {
            return Err(identity_invalid("assign to a harness or a companion"));
        }
        Ok([flag.into(), value.into()])
    };
    let [flag, value] = match (harness, soul) {
        (Some(harness), None) => target("--harness", harness)?,
        (None, Some(soul)) => target("--soul", soul)?,
        _ => {
            return Err(identity_invalid(
                "assign to exactly one harness or companion",
            ))
        }
    };
    Ok(vec![
        "identity".into(),
        "app".into(),
        "assign".into(),
        slug.into(),
        flag,
        value,
        "--json".into(),
    ])
}

fn identity_app_remove_args(slug: &str) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    identity_app_slug(slug)?;
    Ok(vec![
        "identity".into(),
        "app".into(),
        "remove".into(),
        slug.into(),
        "--json".into(),
    ])
}

/// The add-ons `identity addon` switches; `persona-accounts` has its own
/// command (`sandbox on|off`).
const IDENTITY_ADDONS: [&str; 1] = ["github-identity"];

fn identity_addon_args(name: &str, enabled: bool) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if !IDENTITY_ADDONS.contains(&name) {
        return Err(identity_invalid("unknown add-on"));
    }
    let state = if enabled { "on" } else { "off" };
    Ok(vec![
        "identity".into(),
        "addon".into(),
        name.into(),
        state.into(),
        "--json".into(),
    ])
}

/// Never lets key material through an error message, even one agent-bot
/// did not construct (a stray stderr line).
fn identity_error(result: Result<Value, BridgeError>) -> Result<Value, BridgeError> {
    result.map_err(|mut error| {
        if error.message.contains("-----BEGIN") || error.message.contains("PRIVATE KEY") {
            error.message = "agent-bot could not complete the App operation".into();
        }
        if error.code.contains("-----BEGIN") || error.code.len() > 64 {
            error.code = "identity-app-failed".into();
        }
        error
    })
}

fn parse_identity(
    stdout: &[u8],
    stderr: &[u8],
    fallback: &str,
    valid: fn(&Value) -> bool,
) -> Result<Value, BridgeError> {
    identity_error(parse_agent_bot_json(
        stdout,
        stderr,
        "identity-app-failed",
        "agent-bot: ",
        fallback,
        valid,
    ))
}

fn str_field(value: &Value, name: &str) -> Option<String> {
    value.get(name).and_then(Value::as_str).map(str::to_owned)
}

fn str_list(value: &Value, name: &str) -> Vec<Value> {
    value
        .get(name)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| Value::String(s.into()))
                .collect()
        })
        .unwrap_or_default()
}

/// The stored key's public fingerprint and when agent-bot stored it
/// (agent-bot-identity #547): `{fingerprint, updatedAt}`, or null when the
/// row has none (no key, or an agent-bot older than 0.10.33). Only an
/// `SHA256:` fingerprint passes, so nothing secret-shaped can.
fn identity_app_key(row: &Value) -> Value {
    let key = row.get("key").unwrap_or(&Value::Null);
    match str_field(key, "fingerprint") {
        Some(fingerprint)
            if fingerprint.len() <= 128
                && fingerprint.strip_prefix("SHA256:").is_some_and(|rest| {
                    !rest.is_empty()
                        && rest.chars().all(|c| {
                            c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | ':')
                        })
                }) =>
        {
            json!({ "fingerprint": fingerprint, "updatedAt": str_field(key, "updatedAt") })
        }
        _ => Value::Null,
    }
}

/// One list row with only its documented, secret-free fields.
fn identity_app_row(row: &Value) -> Option<Value> {
    let slug = str_field(row, "slug").filter(|s| valid_identity_slug(s))?;
    let installations: Vec<Value> = row
        .get("installations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(json!({
                        "id": item.get("id").and_then(Value::as_u64)?,
                        "account": str_field(item, "account")?,
                        "repositorySelection": match item.get("repositorySelection").and_then(Value::as_str) {
                            Some("all") => "all",
                            _ => "selected",
                        },
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    let mint = row.get("liveMint").unwrap_or(&Value::Null);
    let live_mint = match mint.get("status").and_then(Value::as_str) {
        Some(status @ ("ready" | "failed")) => json!({
            "status": status,
            "code": str_field(mint, "code"),
            "checkedAt": str_field(mint, "checkedAt"),
        }),
        _ => json!({ "status": "unknown" }),
    };
    Some(json!({
        "slug": slug,
        "botLogin": str_field(row, "botLogin").unwrap_or_else(|| format!("{slug}[bot]")),
        "issuerPresent": row.get("issuerPresent").and_then(Value::as_bool).unwrap_or(false),
        "keyPresent": row.get("keyPresent").and_then(Value::as_bool).unwrap_or(false),
        "key": identity_app_key(row),
        "installations": installations,
        "harnesses": str_list(row, "harnesses"),
        "souls": str_list(row, "souls"),
        "liveMint": live_mint,
    }))
}

fn parse_identity_apps_list(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    let list = parse_identity(stdout, stderr, "agent-bot gave no App list", |value| {
        value.get("schemaVersion").and_then(Value::as_u64) == Some(1)
            && value.get("apps").and_then(Value::as_array).is_some()
    })?;
    let apps: Vec<Value> = list["apps"]
        .as_array()
        .map(|rows| rows.iter().filter_map(identity_app_row).collect())
        .unwrap_or_default();
    let mut result = json!({ "apps": apps });
    // agent-bot-identity #554 reports whether the add-on is on; an older
    // bundle has no `addons`, and the menu then shows the switch read-only.
    if let Some(on) = list
        .get("addons")
        .and_then(|addons| addons.get("github-identity"))
        .and_then(Value::as_bool)
    {
        result["addons"] = json!({ "github-identity": on });
    }
    Ok(result)
}

/// A connect or rotation result: `{id, slug, installUrl}`, and `retired`
/// for a rotation.
fn parse_identity_app_result(
    stdout: &[u8],
    stderr: &[u8],
    rotated: bool,
) -> Result<Value, BridgeError> {
    let value = parse_identity(stdout, stderr, "agent-bot gave no App", |value| {
        value.get("id").and_then(Value::as_str).is_some()
            && value
                .get("slug")
                .and_then(Value::as_str)
                .is_some_and(valid_identity_slug)
            && value
                .get("installUrl")
                .and_then(Value::as_str)
                .is_some_and(|url| url.starts_with("https://github.com/"))
    })?;
    let mut result = json!({
        "id": value["id"],
        "slug": value["slug"],
        "installUrl": value["installUrl"],
    });
    if rotated {
        result["retired"] = value
            .get("retired")
            .and_then(Value::as_str)
            .filter(|f| f.starts_with("SHA256:") && f.len() <= 80)
            .map_or(Value::Null, |f| Value::String(f.into()));
    }
    Ok(result)
}

fn parse_identity_app_assign(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    let value = parse_identity(stdout, stderr, "agent-bot gave no assignment", |value| {
        value.get("slug").and_then(Value::as_str).is_some()
            && (value.get("harness").and_then(Value::as_str).is_some()
                || value.get("soul").and_then(Value::as_str).is_some())
    })?;
    let mut result = json!({ "slug": value["slug"] });
    for field in ["harness", "soul"] {
        if let Some(target) = str_field(&value, field) {
            result[field] = Value::String(target);
        }
    }
    Ok(result)
}

/// A removal: `{slug, id, removed: {storeItem: {store, name, existed} | null,
/// configRecord}}`. `storeItem` is null for a metadata-only record.
fn parse_identity_app_remove(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    let value = parse_identity(stdout, stderr, "agent-bot gave no removal", |value| {
        value
            .get("slug")
            .and_then(Value::as_str)
            .is_some_and(valid_identity_slug)
            && value.get("removed").is_some_and(Value::is_object)
    })?;
    let removed = &value["removed"];
    let item = &removed["storeItem"];
    let store_item = match (str_field(item, "store"), str_field(item, "name")) {
        (Some(store), Some(name))
            if !name.contains("-----BEGIN") && !name.contains("PRIVATE KEY") =>
        {
            json!({
                "store": store,
                "name": name,
                "existed": item.get("existed").and_then(Value::as_bool).unwrap_or(false),
            })
        }
        _ => Value::Null,
    };
    Ok(json!({
        "slug": value["slug"],
        "id": str_field(&value, "id"),
        "removed": {
            "storeItem": store_item,
            "configRecord": removed.get("configRecord").and_then(Value::as_bool).unwrap_or(false),
        },
    }))
}

/// An add-on switch: `{addon, enabled, changed}`.
fn parse_identity_addon(stdout: &[u8], stderr: &[u8]) -> Result<Value, BridgeError> {
    let value = parse_identity(stdout, stderr, "agent-bot gave no add-on state", |value| {
        value
            .get("addon")
            .and_then(Value::as_str)
            .is_some_and(|name| IDENTITY_ADDONS.contains(&name))
            && value.get("enabled").and_then(Value::as_bool).is_some()
    })?;
    Ok(json!({
        "addon": value["addon"],
        "enabled": value["enabled"],
        "changed": value.get("changed").and_then(Value::as_bool).unwrap_or(false),
    }))
}

#[derive(Debug, PartialEq)]
enum CreateLine {
    Pending(String),
    Done(Value),
    Failed(BridgeError),
    Other,
}

/// One line of `identity app create --json`.
fn parse_create_line(line: &[u8]) -> CreateLine {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return CreateLine::Other;
    };
    if value.get("status").and_then(Value::as_str) == Some("pending") {
        return match value.get("localUrl").and_then(Value::as_str) {
            Some(url) if url.starts_with("http://127.0.0.1:") && identity_url_allowed(url) => {
                CreateLine::Pending(url.into())
            }
            _ => CreateLine::Failed(BridgeError::new(
                "identity-app-failed",
                "agent-bot gave no App creation page",
            )),
        };
    }
    match parse_identity_app_result(line, b"", false) {
        Ok(result) => CreateLine::Done(result),
        Err(error) if value.get("error").is_some() => CreateLine::Failed(error),
        Err(_) => CreateLine::Other,
    }
}

#[cfg(test)]
mod identity_app_tests {
    use super::*;

    const KEY: &[u8] = b"-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n";

    #[test]
    fn builds_identity_app_arguments() {
        assert_eq!(
            identity_apps_list_args(),
            vec!["identity", "apps", "list", "--json"]
        );
        assert_eq!(
            identity_app_create_args(None, None).unwrap(),
            vec!["identity", "app", "create", "--manifest", "--json"]
        );
        assert_eq!(
            identity_app_create_args(Some("Luna Bot"), Some("qwts")).unwrap(),
            vec![
                "identity",
                "app",
                "create",
                "--manifest",
                "--name",
                "Luna Bot",
                "--org",
                "qwts",
                "--json"
            ]
        );
        assert_eq!(
            identity_app_create_args(Some(""), Some("")).unwrap(),
            vec!["identity", "app", "create", "--manifest", "--json"]
        );
        for (name, org) in [
            (Some("--org"), None),
            (Some("a;b"), None),
            (None, Some("Qwts")),
            (None, Some("-x")),
        ] {
            assert_eq!(
                identity_app_create_args(name, org).unwrap_err().code,
                "identity-app-invalid"
            );
        }
        assert_eq!(
            identity_app_connect_args(
                "123",
                &KeySource::File("/Users/me/Downloads/app.pem".into())
            )
            .unwrap(),
            vec![
                "identity",
                "app",
                "connect",
                "--id",
                "123",
                "--key-file",
                "/Users/me/Downloads/app.pem",
                "--json"
            ]
        );
        for (id, key) in [
            ("", "/k.pem"),
            ("12a", "/k.pem"),
            ("--json", "/k.pem"),
            ("1", "k.pem"),
            ("1", "--json"),
        ] {
            assert_eq!(
                identity_app_connect_args(id, &KeySource::File(key.into()))
                    .unwrap_err()
                    .code,
                "identity-app-invalid"
            );
        }
        assert_eq!(
            identity_app_rotate_args("luna-bot", &KeySource::File("/k.pem".into())).unwrap(),
            vec![
                "identity",
                "app",
                "rotate-key",
                "luna-bot",
                "--key-file",
                "/k.pem",
                "--json"
            ]
        );
        for (slug, key) in [
            ("--json", "/k.pem"),
            ("Luna", "/k.pem"),
            ("", "/k.pem"),
            ("a", ""),
        ] {
            assert_eq!(
                identity_app_rotate_args(slug, &KeySource::File(key.into()))
                    .unwrap_err()
                    .code,
                "identity-app-invalid"
            );
        }
        assert_eq!(
            identity_app_assign_args("luna-bot", None, Some("agent_1")).unwrap(),
            vec!["identity", "app", "assign", "luna-bot", "--soul", "agent_1", "--json"]
        );
        assert_eq!(
            identity_app_assign_args("luna-bot", Some("codex"), None).unwrap(),
            vec![
                "identity",
                "app",
                "assign",
                "luna-bot",
                "--harness",
                "codex",
                "--json"
            ]
        );
        for (slug, harness, soul) in [
            ("luna-bot", None, None),
            ("luna-bot", Some("codex"), Some("agent_1")),
            ("luna-bot", None, Some("--json")),
            ("luna-bot", Some(""), None),
            ("-x", None, Some("agent_1")),
        ] {
            assert_eq!(
                identity_app_assign_args(slug, harness, soul)
                    .unwrap_err()
                    .code,
                "identity-app-invalid"
            );
        }
    }

    #[test]
    fn keeps_only_the_documented_list_fields() {
        let list = parse_identity_apps_list(
            br#"{"schemaVersion":1,"apps":[{"slug":"luna-bot","botLogin":"luna-bot[bot]","issuerPresent":true,"keyPresent":true,"key":{"fingerprint":"SHA256:abc+/=","updatedAt":"2026-10-01T12:00:00Z","pem":"-----BEGIN"},"privateKeyPem":"-----BEGIN RSA PRIVATE KEY-----","installations":[{"id":7,"account":"qwts","repositorySelection":"all","token":"ghs_x"}],"harnesses":["codex"],"souls":["agent_1"],"liveMint":{"status":"ready","code":null,"checkedAt":"2026-10-06T10:00:00Z","jwt":"x"}},{"slug":"Bad Slug"},{"slug":"old-app","keyPresent":false,"liveMint":{"status":"weird"}},{"slug":"odd-key","keyPresent":true,"key":{"fingerprint":"-----BEGIN RSA PRIVATE KEY-----"}}]}
"#,
            b"",
        )
        .unwrap();
        assert_eq!(
            list,
            json!({ "apps": [
                {
                    "slug": "luna-bot", "botLogin": "luna-bot[bot]", "issuerPresent": true, "keyPresent": true,
                    "key": { "fingerprint": "SHA256:abc+/=", "updatedAt": "2026-10-01T12:00:00Z" },
                    "installations": [{ "id": 7, "account": "qwts", "repositorySelection": "all" }],
                    "harnesses": ["codex"], "souls": ["agent_1"],
                    "liveMint": { "status": "ready", "code": null, "checkedAt": "2026-10-06T10:00:00Z" },
                },
                {
                    "slug": "old-app", "botLogin": "old-app[bot]", "issuerPresent": false, "keyPresent": false, "key": null,
                    "installations": [], "harnesses": [], "souls": [], "liveMint": { "status": "unknown" },
                },
                {
                    "slug": "odd-key", "botLogin": "odd-key[bot]", "issuerPresent": false, "keyPresent": true, "key": null,
                    "installations": [], "harnesses": [], "souls": [], "liveMint": { "status": "unknown" },
                },
            ] })
        );
        assert!(!list.to_string().contains("BEGIN"));
        assert!(!list.to_string().contains("ghs_"));
        // The add-on off: an empty list, not a failure.
        assert_eq!(
            parse_identity_apps_list(b"{\"schemaVersion\":1,\"apps\":[]}\n", b"").unwrap(),
            json!({ "apps": [] })
        );
    }

    #[test]
    fn a_failed_or_older_list_is_an_error() {
        assert_eq!(
            parse_identity_apps_list(
                b"{\"error\":{\"code\":\"identity-app-failed\",\"message\":\"App operation failed\"}}\n",
                b""
            )
            .unwrap_err()
            .code,
            "identity-app-failed"
        );
        // agent-bot 0.10.23 hands `identity apps` to its identity command.
        assert_eq!(
            parse_identity_apps_list(b"", b"agent-bot: usage: agent-bot identity show\n")
                .unwrap_err()
                .code,
            "identity-app-failed"
        );
        assert_eq!(
            parse_identity_apps_list(b"{\"apps\":[]}\n", b"")
                .unwrap_err()
                .message,
            "agent-bot gave no App list"
        );
    }

    #[test]
    fn never_surfaces_key_material() {
        let mut stdout = KEY.to_vec();
        stdout.extend_from_slice(b"{\"id\":\"123\",\"slug\":\"luna-bot\",\"installUrl\":\"https://github.com/apps/luna-bot/installations/new\",\"pem\":\"-----BEGIN RSA PRIVATE KEY-----\"}\n");
        let result = parse_identity_app_result(&stdout, b"", false).unwrap();
        assert_eq!(
            result,
            json!({ "id": "123", "slug": "luna-bot", "installUrl": "https://github.com/apps/luna-bot/installations/new" })
        );
        // A key printed on its own is neither a result nor an error message.
        let error = parse_identity_app_result(KEY, KEY, false).unwrap_err();
        assert!(!error.message.contains("BEGIN"), "{error:?}");
        let error = parse_identity_apps_list(b"", KEY).unwrap_err();
        assert!(!error.message.contains("BEGIN") && !error.message.contains("PRIVATE"));
        let error = parse_identity_app_assign(
            b"{\"error\":{\"code\":\"identity-app-failed\",\"message\":\"-----BEGIN PRIVATE KEY-----\"}}\n",
            b"",
        )
        .unwrap_err();
        assert!(!error.message.contains("BEGIN"));
        assert_eq!(parse_create_line(KEY), CreateLine::Other);
    }

    #[test]
    fn parses_rotation_and_assignment_results() {
        let rotated = parse_identity_app_result(
            b"{\"id\":\"123\",\"slug\":\"luna-bot\",\"installUrl\":\"https://github.com/apps/luna-bot/installations/new\",\"retired\":\"SHA256:abc=\",\"action\":\"Delete it.\"}\n",
            b"",
            true,
        )
        .unwrap();
        assert_eq!(rotated["retired"], "SHA256:abc=");
        assert!(rotated.get("action").is_none());
        assert_eq!(
            parse_identity_app_result(
                b"{\"error\":{\"code\":\"identity-app-disabled\",\"message\":\"Enable the github-identity add-on before managing Apps.\"}}\n",
                b"",
                true
            ),
            Err(BridgeError::new(
                "identity-app-disabled",
                "Enable the github-identity add-on before managing Apps."
            ))
        );
        // An install URL that is not GitHub's is not a result.
        assert_eq!(
            parse_identity_app_result(
                b"{\"id\":\"1\",\"slug\":\"a\",\"installUrl\":\"https://evil.example/\"}\n",
                b"",
                false
            )
            .unwrap_err()
            .message,
            "agent-bot gave no App"
        );
        assert_eq!(
            parse_identity_app_assign(
                b"{\"slug\":\"luna-bot\",\"soul\":\"agent_1\",\"x\":1}\n",
                b""
            )
            .unwrap(),
            json!({ "slug": "luna-bot", "soul": "agent_1" })
        );
        assert_eq!(
            parse_identity_app_assign(b"{\"slug\":\"luna-bot\",\"harness\":\"codex\"}\n", b"")
                .unwrap(),
            json!({ "slug": "luna-bot", "harness": "codex" })
        );
        assert_eq!(
            parse_identity_app_assign(b"{\"slug\":\"luna-bot\"}\n", b"")
                .unwrap_err()
                .code,
            "identity-app-failed"
        );
    }

    #[test]
    fn reads_create_lines() {
        assert_eq!(
            parse_create_line(
                b"{\"status\":\"pending\",\"localUrl\":\"http://127.0.0.1:5123/?state=ab\"}"
            ),
            CreateLine::Pending("http://127.0.0.1:5123/?state=ab".into())
        );
        assert!(matches!(
            parse_create_line(b"{\"status\":\"pending\",\"localUrl\":\"https://evil.example/\"}"),
            CreateLine::Failed(_)
        ));
        assert_eq!(
            parse_create_line(b"{\"id\":\"9\",\"slug\":\"luna-bot\",\"installUrl\":\"https://github.com/apps/luna-bot/installations/new\",\"pem\":\"x\"}"),
            CreateLine::Done(json!({ "id": "9", "slug": "luna-bot", "installUrl": "https://github.com/apps/luna-bot/installations/new" }))
        );
        assert_eq!(
            parse_create_line(b"{\"error\":{\"code\":\"identity-app-timeout\",\"message\":\"App creation timed out after 10 minutes; start create again.\"}}"),
            CreateLine::Failed(BridgeError::new(
                "identity-app-timeout",
                "App creation timed out after 10 minutes; start create again."
            ))
        );
        assert_eq!(
            parse_create_line(b"Open http://127.0.0.1:1/"),
            CreateLine::Other
        );
    }

    #[test]
    fn builds_pass_cli_key_arguments() {
        assert_eq!(
            identity_app_connect_args("123", &KeySource::PassCli("luna-bot-key".into())).unwrap(),
            vec![
                "identity",
                "app",
                "connect",
                "--id",
                "123",
                "--pass-cli",
                "luna-bot-key",
                "--json"
            ]
        );
        assert_eq!(
            identity_app_rotate_args("luna-bot", &KeySource::PassCli("k2".into())).unwrap(),
            vec![
                "identity",
                "app",
                "rotate-key",
                "luna-bot",
                "--pass-cli",
                "k2",
                "--json"
            ]
        );
        // agent-bot's `slug()` grammar: lowercase letters, digits and inner
        // dashes, 64 at most; nothing option-shaped or path-shaped.
        for item in [
            "",
            "-x",
            "--json",
            "Luna",
            "a b",
            "a_b",
            "a/b",
            "a-",
            "../k",
            &"a".repeat(65),
        ] {
            assert_eq!(
                identity_app_connect_args("1", &KeySource::PassCli(item.into()))
                    .unwrap_err()
                    .code,
                "identity-app-invalid",
                "{item:?}"
            );
            assert_eq!(
                identity_app_rotate_args("luna-bot", &KeySource::PassCli(item.into()))
                    .unwrap_err()
                    .code,
                "identity-app-invalid",
                "{item:?}"
            );
        }
        assert_eq!(identity_pass_item(&"a".repeat(64)), Ok(()));
        assert_eq!(identity_pass_item("7"), Ok(()));
    }

    #[test]
    fn reads_a_create_from_its_record_files() {
        let dir = std::env::temp_dir().join(format!("geniusbar-create-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = |id: &str, pid: u32, out: &str, err: &str| {
            std::fs::write(
                dir.join(format!("{id}.json")),
                json!({ "pid": pid, "startedAt": "2026-10-07T12:00:00Z" }).to_string(),
            )
            .unwrap();
            std::fs::write(dir.join(format!("{id}.out")), out).unwrap();
            std::fs::write(dir.join(format!("{id}.err")), err).unwrap();
            CreateRecord::read(&dir, id).unwrap()
        };
        const PENDING: &str =
            "{\"status\":\"pending\",\"localUrl\":\"http://127.0.0.1:5123/?state=ab\"}\n";
        const DONE: &str = "{\"id\":\"9\",\"slug\":\"luna-bot\",\"installUrl\":\"https://github.com/apps/luna-bot/installations/new\"}\n";
        const FAILED: &str = "{\"error\":{\"code\":\"identity-app-timeout\",\"message\":\"App creation timed out after 10 minutes; start create again.\"}}\n";
        let alive = std::process::id();
        // No process has this pid.
        let dead = i32::MAX as u32;
        assert_eq!(
            write("1", alive, PENDING, "").state(),
            CreateState::Pending(Some("http://127.0.0.1:5123/?state=ab".into()))
        );
        // Still at the owner's consent dialog.
        assert_eq!(
            write("2", alive, "", "").state(),
            CreateState::Pending(None)
        );
        assert_eq!(
            write("3", dead, PENDING, "").state(),
            CreateState::Failed(BridgeError::new(
                "identity-app-interrupted",
                "GeniusBar or agent-bot stopped before GitHub answered"
            ))
        );
        // The listener's death after a stderr warning is still an interruption.
        assert_eq!(
            write("4", dead, PENDING, "(node) warning\n").state(),
            CreateState::Failed(BridgeError::new(
                "identity-app-interrupted",
                "GeniusBar or agent-bot stopped before GitHub answered"
            ))
        );
        // A result stands whether or not the process is still there.
        for pid in [alive, dead] {
            assert_eq!(
                write("5", pid, &format!("{PENDING}{DONE}"), "").state(),
                CreateState::Complete(json!({
                    "id": "9", "slug": "luna-bot",
                    "installUrl": "https://github.com/apps/luna-bot/installations/new",
                }))
            );
            assert_eq!(
                write("6", pid, &format!("{PENDING}{FAILED}"), "").state(),
                CreateState::Failed(BridgeError::new(
                    "identity-app-timeout",
                    "App creation timed out after 10 minutes; start create again."
                ))
            );
        }
        // Gone before it listened: agent-bot's last word is the reason.
        assert_eq!(
            write("7", dead, "", "agent-bot: usage: agent-bot identity show\n").state(),
            CreateState::Failed(BridgeError::new(
                "identity-app-failed",
                "usage: agent-bot identity show"
            ))
        );
        assert_eq!(
            write("8", dead, "", "").state(),
            CreateState::Failed(BridgeError::new(
                "identity-app-interrupted",
                "GeniusBar or agent-bot stopped before GitHub answered"
            ))
        );
        // Key material on either stream never becomes a message.
        let key = std::str::from_utf8(KEY).unwrap();
        for state in [
            write("9", dead, "", key).state(),
            write("10", dead, key, "").state(),
            write("11", alive, key, key).state(),
        ] {
            assert!(!state.to_json().to_string().contains("BEGIN"), "{state:?}");
        }
        // Not a record: no pid.
        std::fs::write(dir.join("12.json"), "{}").unwrap();
        assert!(CreateRecord::read(&dir, "12").is_none());
        assert!(CreateRecord::read(&dir, "13").is_none());
        // What the web view gets.
        assert_eq!(
            CreateState::Pending(None).to_json(),
            json!({ "status": "pending", "localUrl": null })
        );
        assert_eq!(
            CreateState::Failed(BridgeError::new("identity-app-interrupted", "gone")).to_json(),
            json!({ "status": "failed", "error": { "code": "identity-app-interrupted", "message": "gone" } })
        );
        let record = write("14", alive, PENDING, "");
        record.remove();
        assert!(!record.json.exists() && !record.out.exists() && !record.err.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn formats_record_times() {
        let at = |secs: u64| iso_time(std::time::UNIX_EPOCH + Duration::from_secs(secs));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_791_376_496), "2026-10-07T12:34:56Z");
        assert!(!pid_alive(0));
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn builds_remove_and_addon_arguments() {
        assert_eq!(
            identity_app_remove_args("luna-bot").unwrap(),
            vec!["identity", "app", "remove", "luna-bot", "--json"]
        );
        for slug in ["", "--json", "Luna", "a b"] {
            assert_eq!(
                identity_app_remove_args(slug).unwrap_err().code,
                "identity-app-invalid"
            );
        }
        assert_eq!(
            identity_addon_args("github-identity", true).unwrap(),
            vec!["identity", "addon", "github-identity", "on", "--json"]
        );
        assert_eq!(
            identity_addon_args("github-identity", false).unwrap(),
            vec!["identity", "addon", "github-identity", "off", "--json"]
        );
        for name in ["", "persona-accounts", "--json", "github-identity "] {
            assert_eq!(
                identity_addon_args(name, true).unwrap_err().code,
                "identity-app-invalid"
            );
        }
    }

    #[test]
    fn passes_the_add_on_state_through_the_list() {
        assert_eq!(
            parse_identity_apps_list(
                b"{\"schemaVersion\":1,\"addons\":{\"github-identity\":false,\"x\":1},\"apps\":[]}\n",
                b""
            )
            .unwrap(),
            json!({ "apps": [], "addons": { "github-identity": false } })
        );
        assert_eq!(
            parse_identity_apps_list(
                b"{\"schemaVersion\":1,\"addons\":{\"github-identity\":true},\"apps\":[]}\n",
                b""
            )
            .unwrap()["addons"],
            json!({ "github-identity": true })
        );
        // An older bundle, or a value that is not a bool: no `addons` at all.
        for stdout in [
            &b"{\"schemaVersion\":1,\"apps\":[]}\n"[..],
            &b"{\"schemaVersion\":1,\"addons\":{\"github-identity\":\"on\"},\"apps\":[]}\n"[..],
        ] {
            assert!(parse_identity_apps_list(stdout, b"")
                .unwrap()
                .get("addons")
                .is_none());
        }
    }

    #[test]
    fn parses_removal_and_addon_results() {
        assert_eq!(
            parse_identity_app_remove(
                br#"{"slug":"luna-bot","id":"123","removed":{"storeItem":{"store":"keychain","name":"agent-bot.app.luna-bot/github-app/luna-bot","existed":true,"pem":"x"},"configRecord":true},"extra":1}
"#,
                b""
            )
            .unwrap(),
            json!({
                "slug": "luna-bot",
                "id": "123",
                "removed": {
                    "storeItem": {
                        "store": "keychain",
                        "name": "agent-bot.app.luna-bot/github-app/luna-bot",
                        "existed": true,
                    },
                    "configRecord": true,
                },
            })
        );
        assert_eq!(
            parse_identity_app_remove(
                b"{\"slug\":\"old-app\",\"id\":\"9\",\"removed\":{\"storeItem\":null,\"configRecord\":true}}\n",
                b""
            )
            .unwrap()["removed"],
            json!({ "storeItem": null, "configRecord": true })
        );
        assert_eq!(
            parse_identity_app_remove(
                b"{\"error\":{\"code\":\"identity-app-assigned\",\"message\":\"luna-bot is still used by harness codex and soul agent_1; assign them another App first.\"}}\n",
                b""
            ),
            Err(BridgeError::new(
                "identity-app-assigned",
                "luna-bot is still used by harness codex and soul agent_1; assign them another App first."
            ))
        );
        assert_eq!(
            parse_identity_app_remove(b"{\"slug\":\"luna-bot\"}\n", b"")
                .unwrap_err()
                .message,
            "agent-bot gave no removal"
        );
        assert_eq!(
            parse_identity_addon(
                b"{\"addon\":\"github-identity\",\"enabled\":true,\"changed\":true,\"x\":1}\n",
                b""
            )
            .unwrap(),
            json!({ "addon": "github-identity", "enabled": true, "changed": true })
        );
        assert_eq!(
            parse_identity_addon(
                b"{\"error\":{\"code\":\"identity-app-owner-required\",\"message\":\"The owner did not approve.\"}}\n",
                b""
            ),
            Err(BridgeError::new("identity-app-owner-required", "The owner did not approve."))
        );
        assert_eq!(
            parse_identity_addon(b"{\"addon\":\"other\",\"enabled\":true}\n", b"")
                .unwrap_err()
                .code,
            "identity-app-failed"
        );
    }

    #[test]
    fn opens_only_the_loopback_page_or_github() {
        assert!(identity_url_allowed("http://127.0.0.1:5123/?state=ab"));
        assert!(identity_url_allowed(
            "https://github.com/apps/luna-bot/installations/new"
        ));
        for url in [
            "http://127.0.0.1.evil.example/",
            "http://127.0.0.1:/",
            "http://localhost:5123/",
            "https://github.com.evil.example/",
            "file:///etc/passwd",
            "https://github.com/a b",
            "-a",
        ] {
            assert!(!identity_url_allowed(url), "{url}");
        }
    }

    #[test]
    fn reads_the_open_dialogs_answer() {
        assert_eq!(
            picked_key_file(true, b"/Users/me/Downloads/app.pem\n", b""),
            Ok("/Users/me/Downloads/app.pem".into())
        );
        assert_eq!(
            picked_key_file(false, b"", b"execution error: User canceled. (-128)\n")
                .unwrap_err()
                .code,
            "identity-app-cancelled"
        );
        assert_eq!(
            picked_key_file(false, b"", b"boom\n").unwrap_err().code,
            "identity-app-key-unavailable"
        );
    }
}
