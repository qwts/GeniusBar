//! About GeniusBar (#290): what the app can say about itself for a support
//! report. `about_info` is read from the bundle, `about_running` from the
//! live engines. Nothing here reads a soul, a credential or a conversation;
//! the page shows these values and copies them as they are.

use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime};

use crate::bridge::{last_line, parse_daemon_status, run_agent_bot, run_agent_comms};

/// The engines the bundle carries, as `components.json` names them.
const COMPONENTS: &[&str] = &["agent-bot", "agent-comms"];

/// How much of a component's pinned commit the page shows.
const SHORT_REF: usize = 12;

/// The app's name, version and build, the bundled engines' versions and
/// the OS: `{app: {name, version, build}, bundled: {<name>: {version,
/// ref}}, os: {name, version}}`. The build is the version itself: nothing
/// embeds a commit at build time, so none is invented.
#[tauri::command]
pub async fn about_info<R: Runtime>(app: AppHandle<R>) -> Value {
    let info = app.package_info();
    let name = info.name.clone();
    let version = info.version.to_string();
    let resources = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let bundled: serde_json::Map<String, Value> = COMPONENTS
            .iter()
            .map(|component| {
                let pin = resources
                    .as_deref()
                    .map(|dir| bundled_component(dir, component))
                    .unwrap_or_default();
                (
                    (*component).to_string(),
                    json!({ "version": pin.version, "ref": pin.reference }),
                )
            })
            .collect();
        json!({
            "app": { "name": name, "version": version, "build": version },
            "bundled": bundled,
            "os": { "name": os_name(), "version": os_version() },
        })
    })
    .await
    .unwrap_or(Value::Null)
}

/// What the live engines answer: `{"agent-bot": {running, version},
/// "agent-comms": {version}}`. agent-bot's version is read only while its
/// daemon answers (`daemon status --json`), agent-comms's from the engine
/// itself; the page pairs the latter with the broker's reachability. Null
/// where an engine did not answer.
#[tauri::command]
pub async fn about_running<R: Runtime>(app: AppHandle<R>) -> Value {
    let status_args = vec!["daemon".into(), "status".into(), "--json".into()];
    let running = match run_agent_bot(&app, status_args, "about-unavailable").await {
        Ok(output) => parse_daemon_status(&output.stdout)
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        Err(_) => false,
    };
    let bot = if running {
        match run_agent_bot(&app, vec!["--version".into()], "about-unavailable").await {
            Ok(output) => parse_version_output("agent-bot", &output.stdout),
            Err(_) => None,
        }
    } else {
        None
    };
    let comms = match run_agent_comms(&app, vec!["--version".into()], "about-unavailable").await {
        Ok(output) => parse_version_output("agent-comms", &output.stdout),
        Err(_) => None,
    };
    json!({
        "agent-bot": { "running": running, "version": bot },
        "agent-comms": { "version": comms },
    })
}

/// A bundled component's pin: its package version and the commit it was
/// fetched at (`scripts/fetch-components.mjs` leaves `<name>.ref` beside it).
#[derive(Debug, Default, PartialEq)]
struct ComponentPin {
    version: Option<String>,
    reference: Option<String>,
}

/// Reads `<resources>/components/<name>/package.json` and
/// `<resources>/components/<name>.ref`; each absent or malformed is None.
fn bundled_component(resources: &Path, name: &str) -> ComponentPin {
    let components = resources.join("components");
    let version = std::fs::read(components.join(name).join("package.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|package| {
            package
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|version| looks_like_version(version));
    let reference = std::fs::read_to_string(components.join(format!("{name}.ref")))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| text.len() == 40 && text.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(|sha| sha[..SHORT_REF].to_string());
    ComponentPin { version, reference }
}

/// `1.2.3`, `1.2.3-beta.1`: digits first, then version characters only.
fn looks_like_version(text: &str) -> bool {
    text.bytes().next().is_some_and(|b| b.is_ascii_digit())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}

/// The version an engine's `--version` prints: its last line, with or
/// without the `<name> ` prefix (`agent-comms 0.3.14`, `0.10.49`).
fn parse_version_output(name: &str, stdout: &[u8]) -> Option<String> {
    let line = last_line(stdout);
    let version = line.strip_prefix(name).map(str::trim).unwrap_or(&line);
    let version = version.split_whitespace().next()?;
    looks_like_version(version).then(|| version.to_string())
}

/// The OS as the page names it.
fn os_name() -> &'static str {
    os_name_for(std::env::consts::OS)
}

fn os_name_for(os: &str) -> &'static str {
    match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        _ => "Unknown OS",
    }
}

/// macOS's `sw_vers -productVersion`; None elsewhere, or when it fails.
fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| parse_sw_vers(&output.stdout))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// `sw_vers -productVersion` prints one line, such as `26.0.1`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_sw_vers(stdout: &[u8]) -> Option<String> {
    let line = last_line(stdout);
    looks_like_version(&line).then_some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resources(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("geniusbar-about-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("components")).unwrap();
        dir
    }

    #[test]
    fn reads_a_bundled_component_pin() {
        let dir = resources("pin");
        let bot = dir.join("components").join("agent-bot");
        std::fs::create_dir_all(&bot).unwrap();
        std::fs::write(
            bot.join("package.json"),
            r#"{"name":"agent-bot-identity","version":"0.10.49"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("components").join("agent-bot.ref"),
            "a5e7e7b3de481df10ec03c41a979607b3d34666f\n",
        )
        .unwrap();
        assert_eq!(
            bundled_component(&dir, "agent-bot"),
            ComponentPin {
                version: Some("0.10.49".into()),
                reference: Some("a5e7e7b3de48".into())
            }
        );
        // Not fetched: nothing is invented for it.
        assert_eq!(
            bundled_component(&dir, "agent-comms"),
            ComponentPin::default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_malformed_pins() {
        let dir = resources("malformed");
        let comms = dir.join("components").join("agent-comms");
        std::fs::create_dir_all(&comms).unwrap();
        std::fs::write(comms.join("package.json"), r#"{"version":"../etc"}"#).unwrap();
        std::fs::write(dir.join("components").join("agent-comms.ref"), "v0.3.14\n").unwrap();
        assert_eq!(
            bundled_component(&dir, "agent-comms"),
            ComponentPin::default()
        );
        std::fs::write(comms.join("package.json"), "not json").unwrap();
        assert_eq!(
            bundled_component(&dir, "agent-comms"),
            ComponentPin::default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_an_engine_version_line() {
        assert_eq!(
            parse_version_output("agent-comms", b"agent-comms 0.3.14\n"),
            Some("0.3.14".into())
        );
        assert_eq!(
            parse_version_output("agent-bot", b"0.10.49\n"),
            Some("0.10.49".into())
        );
        assert_eq!(
            parse_version_output("agent-bot", b"warning: something\n0.10.49-beta.1\n\n"),
            Some("0.10.49-beta.1".into())
        );
        assert_eq!(parse_version_output("agent-bot", b""), None);
        assert_eq!(
            parse_version_output("agent-bot", b"agent-bot: unknown command: --version\n"),
            None
        );
        assert_eq!(parse_version_output("agent-bot", b"/Users/me/x\n"), None);
    }

    #[test]
    fn parses_sw_vers_and_names_the_os() {
        assert_eq!(parse_sw_vers(b"26.0.1\n"), Some("26.0.1".into()));
        assert_eq!(parse_sw_vers(b""), None);
        assert_eq!(parse_sw_vers(b"ProductVersion: 26.0\n"), None);
        assert_eq!(os_name_for("macos"), "macOS");
        assert_eq!(os_name_for("windows"), "Windows");
        assert_eq!(os_name_for("plan9"), "Unknown OS");
    }
}
