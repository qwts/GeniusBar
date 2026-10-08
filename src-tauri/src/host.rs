//! Host capabilities (#46): what this computer can do before the first
//! launch, established by the shell and never inferred from the operating
//! system's name alone. Each tool the bundle ships (git, Node and the
//! command-line tools) is probed where the bundle put it, never on PATH, by
//! starting its `--version`; the build's signing and updater facts come
//! from the configuration the build embedded. The web view picks its copy
//! from the `platform` here, so a Windows PC never sees the macOS
//! command-line-tools step and a Mac keeps that step unchanged.
//!
//! The payload: `{platform: "macos"|"windows"|"linux"|"unknown", tools:
//! [{id: "git"|"node"|"cli", bundled, state: "ready"|"missing"|"failed",
//! message}], build: {signed: bool|null, updater: bool}}`. `checking` is the
//! web view's own state while an answer is on its way; the shell never
//! reports it. `message` is the failure's last line, null otherwise.
//! `signed` is null where the build does not record it (macOS signs through
//! the bundler's environment, not the configuration).

use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use tauri::{AppHandle, Manager, Runtime};

use crate::bridge::last_line;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    Ready,
    Missing,
    Failed,
}

/// One tool the first launch needs, as the probe found it.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Tool {
    pub id: &'static str,
    /// Whether the copy probed is the bundle's own (a Mac without the
    /// bundled git may still have Apple's command line tools).
    pub bundled: bool,
    pub state: ToolState,
    /// Why it failed: the process's last error line, or the OS error.
    pub message: Option<String>,
}

/// What the build knows about itself.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Build {
    /// Whether the build was signed; None where the build does not say.
    pub signed: Option<bool>,
    /// Whether this build can check for and install updates.
    pub updater: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct HostCapabilities {
    pub platform: &'static str,
    pub tools: Vec<Tool>,
    pub build: Build,
}

/// The platform as the web view names it, from `std::env::consts::OS`.
pub fn platform_name(os: &str) -> &'static str {
    match os {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => "unknown",
    }
}

/// What one probe starts: a program with its arguments, and the files it
/// needs to be there first (a script the program runs).
struct Probe {
    program: PathBuf,
    args: Vec<OsString>,
    required: Vec<PathBuf>,
}

impl Probe {
    fn version(program: PathBuf) -> Self {
        Self {
            program,
            args: vec!["--version".into()],
            required: Vec::new(),
        }
    }

    /// `node <script> --version`.
    fn script(node: &Path, script: PathBuf) -> Self {
        Self {
            program: node.to_path_buf(),
            args: vec![script.clone().into_os_string(), "--version".into()],
            required: vec![script],
        }
    }

    /// Missing when a file it needs is not there; otherwise what starting
    /// it says.
    fn run(&self) -> (ToolState, Option<String>) {
        if !self.program.is_file() || self.required.iter().any(|path| !path.is_file()) {
            return (ToolState::Missing, None);
        }
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // A console program started from the tray app must not flash a
        // console window of its own.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        outcome(command.output())
    }
}

/// What a `--version` start says: ready when it exited well; otherwise
/// failed, with the last line it printed (stderr first) or the exit
/// status, or the OS error that stopped it starting.
pub fn outcome(result: std::io::Result<Output>) -> (ToolState, Option<String>) {
    match result {
        Err(error) => (ToolState::Failed, Some(error.to_string())),
        Ok(output) if output.status.success() => (ToolState::Ready, None),
        Ok(output) => {
            let mut line = last_line(&output.stderr);
            if line.is_empty() {
                line = last_line(&output.stdout);
            }
            if line.is_empty() {
                line = format!("exited with {}", output.status);
            }
            (ToolState::Failed, Some(line))
        }
    }
}

/// The command-line tools are two engines on the bundled Node; the row is
/// as ready as the worse of them, naming the one that failed.
pub fn merge_cli(parts: &[(&str, ToolState, Option<String>)]) -> (ToolState, Option<String>) {
    if parts
        .iter()
        .any(|(_, state, _)| *state == ToolState::Missing)
    {
        return (ToolState::Missing, None);
    }
    match parts
        .iter()
        .find(|(_, state, _)| *state == ToolState::Failed)
    {
        Some((name, _, message)) => (
            ToolState::Failed,
            Some(match message {
                Some(message) => format!("{name}: {message}"),
                None => name.to_string(),
            }),
        ),
        None => (ToolState::Ready, None),
    }
}

/// Probes the three tools where the bundle keeps them. `node` is the
/// sidecar beside the executable, or why it could not be located.
pub fn probe_tools(resources: &Path, node: Result<PathBuf, String>) -> Vec<Tool> {
    let git = {
        let (state, message) = Probe::version(crate::starter::bundled_git_path(resources)).run();
        // A Mac without the bundled git (a development build) still has git
        // once Apple's command line tools are installed.
        if state != ToolState::Ready && crate::starter::apple_tools_installed() {
            Tool {
                id: "git",
                bundled: false,
                state: ToolState::Ready,
                message: None,
            }
        } else {
            Tool {
                id: "git",
                bundled: true,
                state,
                message,
            }
        }
    };
    let (node_tool, cli) = match &node {
        Ok(node) => {
            let (state, message) = Probe::version(node.clone()).run();
            let components = resources.join("components");
            let parts = [
                (
                    "agent-bot",
                    Probe::script(node, components.join("agent-bot").join("agent-bot.mjs")),
                ),
                (
                    "agent-comms",
                    Probe::script(
                        node,
                        components
                            .join("agent-comms")
                            .join("bin")
                            .join("agent-comms.mjs"),
                    ),
                ),
            ];
            let results: Vec<(&str, ToolState, Option<String>)> = if state == ToolState::Ready {
                parts
                    .iter()
                    .map(|(name, probe)| {
                        let (state, message) = probe.run();
                        (*name, state, message)
                    })
                    .collect()
            } else {
                // Without a Node that starts, the scripts cannot be tried;
                // their files decide between missing and failed.
                parts
                    .iter()
                    .map(|(name, probe)| {
                        let present = probe.required.iter().all(|path| path.is_file());
                        (
                            *name,
                            if present {
                                ToolState::Failed
                            } else {
                                ToolState::Missing
                            },
                            present.then(|| "the bundled Node did not start".to_string()),
                        )
                    })
                    .collect()
            };
            ((state, message), merge_cli(&results))
        }
        Err(error) => (
            (ToolState::Failed, Some(error.clone())),
            (ToolState::Failed, Some(error.clone())),
        ),
    };
    vec![
        git,
        Tool {
            id: "node",
            bundled: true,
            state: node_tool.0,
            message: node_tool.1,
        },
        Tool {
            id: "cli",
            bundled: true,
            state: cli.0,
            message: cli.1,
        },
    ]
}

/// The build's facts from its embedded configuration: the updater is on
/// when a key and an endpoint were built in (`updates::configured`); a
/// Windows build is signed when the release workflow's `signCommand` was
/// built in (ADR-0046 decision 8). macOS signs through the bundler's
/// environment, which the configuration does not record.
pub fn build_facts(config: &tauri::Config) -> Build {
    build_facts_from(
        config.bundle.windows.sign_command.is_some(),
        config.plugins.0.get("updater"),
        cfg!(windows),
    )
}

fn build_facts_from(
    sign_command: bool,
    updater: Option<&serde_json::Value>,
    windows: bool,
) -> Build {
    Build {
        signed: windows.then_some(sign_command),
        updater: crate::updates::configured(updater),
    }
}

/// The host's capabilities, probed now. Each call probes again, which is
/// what the first launch's Retry asks for.
#[tauri::command]
pub async fn host_capabilities<R: Runtime>(app: AppHandle<R>) -> Result<HostCapabilities, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let build = build_facts(app.config());
    let node = crate::bridge::node_sidecar();
    let host = tauri::async_runtime::spawn_blocking(move || HostCapabilities {
        platform: platform_name(std::env::consts::OS),
        tools: probe_tools(&resources, node),
        build,
    })
    .await
    .map_err(|e| e.to_string())?;
    let summary: Vec<String> = host
        .tools
        .iter()
        .map(|tool| format!("{} {:?}", tool.id, tool.state).to_lowercase())
        .collect();
    crate::windows::log_line(
        &app,
        &format!(
            "host capabilities {}: {}; signed {:?}, updater {}",
            host.platform,
            summary.join(", "),
            host.build.signed,
            host.build.updater
        ),
    );
    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("geniusbar-host-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_the_platform_the_web_view_expects() {
        assert_eq!(platform_name("macos"), "macos");
        assert_eq!(platform_name("windows"), "windows");
        assert_eq!(platform_name("linux"), "linux");
        assert_eq!(platform_name("freebsd"), "unknown");
    }

    #[test]
    fn a_tool_that_is_not_there_is_missing_not_failed() {
        let dir = scratch("missing");
        let probe = Probe::version(dir.join("nope"));
        assert_eq!(probe.run(), (ToolState::Missing, None));
        // A script the program needs counts the same way.
        let probe = Probe::script(&dir.join("nope"), dir.join("script.mjs"));
        assert_eq!(probe.run(), (ToolState::Missing, None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn reports_what_a_start_says() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("outcome");
        let write = |name: &str, body: &str| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let ok = write("ok", "echo 1.2.3");
        assert_eq!(Probe::version(ok).run(), (ToolState::Ready, None));
        let loud = write("loud", "echo 'libfoo.so: not found' >&2; exit 127");
        assert_eq!(
            Probe::version(loud).run(),
            (ToolState::Failed, Some("libfoo.so: not found".into()))
        );
        let quiet = write("quiet", "exit 3");
        assert_eq!(
            Probe::version(quiet).run(),
            (ToolState::Failed, Some("exited with exit status: 3".into()))
        );
        // Present but not startable: the OS error is the message.
        let plain = dir.join("plain");
        std::fs::write(&plain, "not a program").unwrap();
        let (state, message) = Probe::version(plain).run();
        assert_eq!(state, ToolState::Failed);
        assert!(message.is_some_and(|m| !m.is_empty()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cli_row_is_as_ready_as_its_worse_engine() {
        let ready = ("agent-bot", ToolState::Ready, None);
        assert_eq!(
            merge_cli(&[ready.clone(), ("agent-comms", ToolState::Ready, None)]),
            (ToolState::Ready, None)
        );
        assert_eq!(
            merge_cli(&[
                ready.clone(),
                ("agent-comms", ToolState::Failed, Some("boom".into()))
            ]),
            (ToolState::Failed, Some("agent-comms: boom".into()))
        );
        assert_eq!(
            merge_cli(&[
                ("agent-bot", ToolState::Failed, Some("boom".into())),
                ("agent-comms", ToolState::Missing, None)
            ]),
            (ToolState::Missing, None)
        );
        assert_eq!(
            merge_cli(&[("agent-bot", ToolState::Failed, None)]),
            (ToolState::Failed, Some("agent-bot".into()))
        );
    }

    #[test]
    fn probes_every_tool_where_the_bundle_keeps_it() {
        let dir = scratch("probe");
        let tools = probe_tools(&dir, Err("no node beside the executable".into()));
        assert_eq!(
            tools.iter().map(|t| t.id).collect::<Vec<_>>(),
            ["git", "node", "cli"]
        );
        // Without the bundled git the row is missing, unless this Mac has
        // Apple's tools, which the probe then reports as not bundled.
        let git = &tools[0];
        assert!(
            (git.state == ToolState::Missing && git.bundled)
                || (git.state == ToolState::Ready && !git.bundled)
        );
        assert_eq!(tools[1].state, ToolState::Failed);
        assert_eq!(
            tools[1].message.as_deref(),
            Some("no node beside the executable")
        );
        assert_eq!(tools[2].state, ToolState::Failed);
        // A Node path that is not there makes Node missing and the scripts
        // missing too, not failed.
        let tools = probe_tools(&dir, Ok(dir.join("node")));
        assert_eq!(
            tools[1],
            Tool {
                id: "node",
                bundled: true,
                state: ToolState::Missing,
                message: None
            }
        );
        assert_eq!(
            tools[2],
            Tool {
                id: "cli",
                bundled: true,
                state: ToolState::Missing,
                message: None
            }
        );
        // With the scripts present but no Node, the row is failed and says why.
        for script in ["agent-bot/agent-bot.mjs", "agent-comms/bin/agent-comms.mjs"] {
            let path = dir.join("components").join(script);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        let tools = probe_tools(&dir, Ok(dir.join("node")));
        assert_eq!(tools[2].state, ToolState::Failed);
        assert_eq!(
            tools[2].message.as_deref(),
            Some("agent-bot: the bundled Node did not start")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_facts_come_from_the_embedded_configuration() {
        let updater = json!({ "pubkey": "k", "endpoints": ["https://x"] });
        assert_eq!(
            build_facts_from(true, Some(&updater), true),
            Build {
                signed: Some(true),
                updater: true
            }
        );
        assert_eq!(
            build_facts_from(false, None, true),
            Build {
                signed: Some(false),
                updater: false
            }
        );
        // macOS does not record signing in the configuration.
        assert_eq!(
            build_facts_from(false, Some(&updater), false),
            Build {
                signed: None,
                updater: true
            }
        );
        // The stock configuration is an unsigned development build.
        let facts = build_facts(&tauri::Config::default());
        assert!(!facts.updater);
        assert_eq!(facts.signed, cfg!(windows).then_some(false));
    }

    #[test]
    fn serializes_as_the_web_view_reads_it() {
        let host = HostCapabilities {
            platform: "windows",
            tools: vec![Tool {
                id: "git",
                bundled: true,
                state: ToolState::Failed,
                message: Some("boom".into()),
            }],
            build: Build {
                signed: Some(false),
                updater: false,
            },
        };
        assert_eq!(
            serde_json::to_value(&host).unwrap(),
            json!({
                "platform": "windows",
                "tools": [{ "id": "git", "bundled": true, "state": "failed", "message": "boom" }],
                "build": { "signed": false, "updater": false }
            })
        );
    }
}
