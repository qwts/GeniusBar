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

fn last_line(bytes: &[u8]) -> String {
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
async fn run_agent_bot<R: Runtime>(
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
/// a daemon turn found missing or expired (#84), and its role line. From
/// `population show <agentId>` (pretty JSON); only those fields come back,
/// so paths and transcript locators never reach the web view.
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
                "computerUse": field("computerUse"),
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
  "roleLine": "Lead, 2 subagents",
  "computerUse": false
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
/// --json`: `{agentId, name, handle, wake, comms, retired, archived}`.
/// Nothing is deleted: the soul stops waking, leaves agent-comms, is retired
/// and its folder moves to the souls folder's `.archive`. agent-bot refuses
/// while the soul runs (`soul-running`) and owner-gates the rest (its
/// consent dialog, Touch ID); GeniusBar never asks itself.
#[tauri::command]
pub async fn soul_remove<R: Runtime>(
    app: AppHandle<R>,
    agent: String,
) -> Result<Value, BridgeError> {
    let args = soul_remove_args(&agent)?;
    let output = run_agent_bot(&app, args, "soul-remove-unavailable").await?;
    parse_soul_remove(&output.stdout, &output.stderr)
}

fn soul_remove_args(agent: &str) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    if agent.trim().is_empty() || agent.starts_with('-') || agent.chars().any(char::is_control) {
        return Err(BridgeError::new(
            "soul-remove-invalid",
            "agent must be an agent id",
        ));
    }
    Ok(vec![
        "soul".into(),
        "remove".into(),
        agent.into(),
        "--json".into(),
    ])
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

fn parse_daemon_status(stdout: &[u8]) -> Value {
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
            soul_remove_args("agent_1").unwrap(),
            vec!["soul", "remove", "agent_1", "--json"]
        );
        for agent in ["", "  ", "--json", "-x", "a\nb"] {
            assert_eq!(
                soul_remove_args(agent).unwrap_err().code,
                "soul-remove-invalid"
            );
        }
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
    if value.trim().is_empty() || value.starts_with('-') {
        return Err(BridgeError::new(
            "soul-profile-failed",
            &format!("not a soul profile {what}: {value}"),
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

/// Connects an existing App: its ID and a private key file the owner picks
/// in the native open dialog. Only the path goes to agent-bot; the key is
/// never read here. `{id, slug, installUrl}`.
#[tauri::command]
pub async fn identity_app_connect<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    prompt: String,
) -> Result<Value, BridgeError> {
    identity_app_id(&id)?;
    let key = pick_key_file(prompt).await?;
    let args = identity_app_connect_args(&id, &key)?;
    let output = run_agent_bot(&app, args, "identity-app-unavailable").await?;
    parse_identity_app_result(&output.stdout, &output.stderr, false)
}

/// Rotates a managed App's key to a new file the owner downloaded from the
/// App's settings on github.com and picks in the native open dialog.
/// `{id, slug, installUrl, retired}`; `retired` is the old key's public
/// fingerprint, which the owner must still delete on github.com.
#[tauri::command]
pub async fn identity_app_rotate_key<R: Runtime>(
    app: AppHandle<R>,
    slug: String,
    prompt: String,
) -> Result<Value, BridgeError> {
    identity_app_slug(&slug)?;
    let key = pick_key_file(prompt).await?;
    let args = identity_app_rotate_args(&slug, &key)?;
    let output = run_agent_bot(&app, args, "identity-app-unavailable").await?;
    parse_identity_app_result(&output.stdout, &output.stderr, true)
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

/// Starts GitHub's manifest flow with `identity app create --manifest
/// --json`: agent-bot asks the owner, opens a ten-minute loopback listener
/// and prints `{status: "pending", localUrl}`, which this returns at once
/// with a `handle`; the same process later prints `{id, slug, installUrl}`
/// or an error, which `identity_app_create_status` reports.
#[tauri::command]
pub async fn identity_app_create<R: Runtime>(
    app: AppHandle<R>,
    jobs: State<'_, IdentityJobs>,
    name: Option<String>,
    org: Option<String>,
) -> Result<Value, BridgeError> {
    let args = identity_app_create_args(name.as_deref(), org.as_deref())?;
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
    let (mut events, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| unavailable(e.to_string()))?
        .envs(HOST_ENV.iter().copied())
        .args(argv)
        .spawn()
        .map_err(|e| unavailable(e.to_string()))?;
    let handle = jobs.next.fetch_add(1, Ordering::Relaxed) + 1;
    jobs.jobs.lock().unwrap().insert(
        handle,
        IdentityJob {
            state: json!({ "status": "pending" }),
            child: Some(child),
        },
    );
    let (first, started) = oneshot::channel::<Result<String, BridgeError>>();
    let watcher = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut first = Some(first);
        let mut last_stderr = Vec::new();
        let mut settled = false;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => match parse_create_line(&line) {
                    CreateLine::Pending(url) => {
                        if let Some(sender) = first.take() {
                            let _ = sender.send(Ok(url.clone()));
                        }
                        watcher
                            .state::<IdentityJobs>()
                            .update(handle, json!({ "status": "pending", "localUrl": url }));
                    }
                    CreateLine::Done(result) => {
                        settled = true;
                        watcher
                            .state::<IdentityJobs>()
                            .finish(handle, json!({ "status": "complete", "result": result }));
                    }
                    CreateLine::Failed(error) => {
                        settled = true;
                        if let Some(sender) = first.take() {
                            let _ = sender.send(Err(error.clone()));
                        }
                        watcher.state::<IdentityJobs>().finish(
                            handle,
                            json!({ "status": "failed", "error": { "code": error.code, "message": error.message } }),
                        );
                    }
                    CreateLine::Other => {}
                },
                CommandEvent::Stderr(line) => last_stderr = line,
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
        if !settled {
            let error = identity_error(parse_agent_bot_json(
                b"",
                &last_stderr,
                "identity-app-failed",
                "agent-bot: ",
                "agent-bot ended App creation without a result",
                |_| false,
            ))
            .unwrap_err();
            if let Some(sender) = first.take() {
                let _ = sender.send(Err(error.clone()));
            }
            watcher.state::<IdentityJobs>().finish(
                handle,
                json!({ "status": "failed", "error": { "code": error.code, "message": error.message } }),
            );
        }
    });
    // agent-bot asks the owner before it listens, so the first line waits
    // on that answer; a dialog left alone gives up with the listener.
    match tokio::time::timeout(Duration::from_secs(600), started).await {
        Ok(Ok(Ok(local_url))) => Ok(json!({ "handle": handle, "localUrl": local_url })),
        Ok(Ok(Err(error))) => {
            jobs.jobs.lock().unwrap().remove(&handle);
            Err(error)
        }
        _ => {
            jobs.cancel(handle);
            jobs.jobs.lock().unwrap().remove(&handle);
            Err(BridgeError::new(
                "identity-app-timeout",
                "agent-bot did not start App creation",
            ))
        }
    }
}

/// Where a create started by `identity_app_create` stands: `{status:
/// "pending", localUrl}`, `{status: "complete", result: {id, slug,
/// installUrl}}` or `{status: "failed", error: {code, message}}`.
#[tauri::command]
pub fn identity_app_create_status(
    jobs: State<'_, IdentityJobs>,
    handle: u64,
) -> Result<Value, BridgeError> {
    jobs.jobs
        .lock()
        .unwrap()
        .get(&handle)
        .map(|job| job.state.clone())
        .ok_or_else(|| {
            BridgeError::new(
                "identity-app-job-not-found",
                "this App creation is no longer running",
            )
        })
}

/// Stops a create that is still waiting for GitHub; agent-bot's listener
/// closes with its process.
#[tauri::command]
pub fn identity_app_create_cancel(jobs: State<'_, IdentityJobs>, handle: u64) {
    jobs.cancel(handle);
    jobs.jobs.lock().unwrap().remove(&handle);
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
    let status = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
    })
    .await
    .map_err(|e| BridgeError::new("identity-app-open-failed", &e.to_string()))?
    .map_err(|e| BridgeError::new("identity-app-open-failed", &e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(BridgeError::new(
            "identity-app-open-failed",
            "the browser could not be opened",
        ))
    }
}

/// Create jobs this app started; each keeps its agent-bot process until it
/// finishes or is cancelled.
#[derive(Default)]
pub struct IdentityJobs {
    next: AtomicU64,
    jobs: Mutex<HashMap<u64, IdentityJob>>,
}

struct IdentityJob {
    state: Value,
    child: Option<CommandChild>,
}

impl IdentityJobs {
    fn update(&self, handle: u64, state: Value) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(&handle) {
            job.state = state;
        }
    }

    fn finish(&self, handle: u64, state: Value) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(&handle) {
            job.state = state;
            job.child = None;
        }
    }

    fn cancel(&self, handle: u64) {
        let child = self
            .jobs
            .lock()
            .unwrap()
            .get_mut(&handle)
            .and_then(|job| job.child.take());
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

/// Lets the owner pick a private key file in the native open dialog.
/// `prompt` goes to AppleScript as an argument, never as script text.
async fn pick_key_file(prompt: String) -> Result<String, BridgeError> {
    let output = tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| BridgeError::new("identity-app-key-unavailable", &e.to_string()))?
    .map_err(|e| BridgeError::new("identity-app-key-unavailable", &e.to_string()))?;
    picked_key_file(output.status.success(), &output.stdout, &output.stderr)
}

/// The chosen path, or `identity-app-cancelled` when the owner closed the
/// dialog (AppleScript error -128).
fn picked_key_file(ok: bool, stdout: &[u8], stderr: &[u8]) -> Result<String, BridgeError> {
    let path = last_line(stdout);
    if ok && path.starts_with('/') {
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

fn identity_app_connect_args(id: &str, key: &str) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    identity_app_id(id)?;
    identity_key_path(key)?;
    Ok(vec![
        "identity".into(),
        "app".into(),
        "connect".into(),
        "--id".into(),
        id.into(),
        "--key-file".into(),
        key.into(),
        "--json".into(),
    ])
}

fn identity_app_rotate_args(slug: &str, key: &str) -> Result<Vec<std::ffi::OsString>, BridgeError> {
    identity_app_slug(slug)?;
    identity_key_path(key)?;
    Ok(vec![
        "identity".into(),
        "app".into(),
        "rotate-key".into(),
        slug.into(),
        "--key-file".into(),
        key.into(),
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
    Ok(json!({ "apps": apps }))
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
            identity_app_connect_args("123", "/Users/me/Downloads/app.pem").unwrap(),
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
                identity_app_connect_args(id, key).unwrap_err().code,
                "identity-app-invalid"
            );
        }
        assert_eq!(
            identity_app_rotate_args("luna-bot", "/k.pem").unwrap(),
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
                identity_app_rotate_args(slug, key).unwrap_err().code,
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
            br#"{"schemaVersion":1,"apps":[{"slug":"luna-bot","botLogin":"luna-bot[bot]","issuerPresent":true,"keyPresent":true,"privateKeyPem":"-----BEGIN RSA PRIVATE KEY-----","installations":[{"id":7,"account":"qwts","repositorySelection":"all","token":"ghs_x"}],"harnesses":["codex"],"souls":["agent_1"],"liveMint":{"status":"ready","code":null,"checkedAt":"2026-10-06T10:00:00Z","jwt":"x"}},{"slug":"Bad Slug"},{"slug":"old-app","keyPresent":false,"liveMint":{"status":"weird"}}]}
"#,
            b"",
        )
        .unwrap();
        assert_eq!(
            list,
            json!({ "apps": [
                {
                    "slug": "luna-bot", "botLogin": "luna-bot[bot]", "issuerPresent": true, "keyPresent": true,
                    "installations": [{ "id": 7, "account": "qwts", "repositorySelection": "all" }],
                    "harnesses": ["codex"], "souls": ["agent_1"],
                    "liveMint": { "status": "ready", "code": null, "checkedAt": "2026-10-06T10:00:00Z" },
                },
                {
                    "slug": "old-app", "botLogin": "old-app[bot]", "issuerPresent": false, "keyPresent": false,
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
