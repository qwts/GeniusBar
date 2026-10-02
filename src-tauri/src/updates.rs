//! Updates from this repository's GitHub releases (ADR-0004 decision 6).
//! The updater's public key and endpoint are release configuration passed
//! at build time (decision 8); a build without them runs with updates off.
//! Checks run here, at startup and from the tray, so the web view needs no
//! updater permissions.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde_json::{json, Value};
use tauri::{menu::MenuItem, AppHandle, Emitter, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The tray menu item's id.
pub const MENU_ID: &str = "updates";

/// True when the build carries an updater public key and an endpoint. The
/// plugin refuses to start without a key, so it is registered only then.
pub fn configured(updater: Option<&Value>) -> bool {
    let Some(updater) = updater else {
        return false;
    };
    let pubkey = updater
        .get("pubkey")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    let endpoints = updater
        .get("endpoints")
        .and_then(Value::as_array)
        .is_some_and(|list| !list.is_empty());
    pubkey && endpoints
}

/// What the tray item and the panel show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Disabled,
    Idle,
    Checking,
    UpToDate,
    Available(String),
    Installing(String),
    /// The bundle is swapped; a restart puts the new version in charge.
    ReadyToRestart(String),
    Failed,
}

/// The tray item's text and whether it can be clicked.
pub fn label(status: &Status) -> (String, bool) {
    match status {
        Status::Disabled => ("Updates Off in This Build".into(), false),
        Status::Idle => ("Check for Updates…".into(), true),
        Status::Checking => ("Checking for Updates…".into(), false),
        Status::UpToDate => ("GeniusBar Is Up to Date".into(), true),
        Status::Available(version) => (format!("Install GeniusBar {version} and Restart"), true),
        Status::Installing(version) => (format!("Installing GeniusBar {version}…"), false),
        Status::ReadyToRestart(version) => (format!("Restart to Finish GeniusBar {version}"), true),
        Status::Failed => ("Update Failed — Try Again".into(), true),
    }
}

/// The status as the panel sees it: `{"state": "…", "version": "…"|null}`.
pub fn payload(status: &Status) -> Value {
    let (state, version) = match status {
        Status::Disabled => ("disabled", None),
        Status::Idle => ("idle", None),
        Status::Checking => ("checking", None),
        Status::UpToDate => ("up-to-date", None),
        Status::Available(v) => ("available", Some(v)),
        Status::Installing(v) => ("installing", Some(v)),
        Status::ReadyToRestart(v) => ("ready-to-restart", Some(v)),
        Status::Failed => ("failed", None),
    };
    json!({ "state": state, "version": version })
}

/// Where a found update sits between the check and the restart.
#[derive(Default)]
enum Phase {
    /// Nothing waiting: a click checks for an update.
    #[default]
    None,
    /// Checked and waiting for the install click.
    Pending(Box<Update>),
    /// Installed; a click forces the restart a request might have lost.
    Installed,
}

#[derive(Default)]
pub struct Updates {
    /// Set once the plugin is registered.
    enabled: AtomicBool,
    /// A check or install is running; further clicks wait for it.
    busy: AtomicBool,
    /// The update's position between a check and the restart.
    phase: Mutex<Phase>,
    /// The last status shown; the panel reads it back on mount.
    status: Mutex<Option<Status>>,
    item: Mutex<Option<MenuItem<Wry>>>,
}

/// Registers the updater plugin when this build is configured for it.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    if configured(app.config().plugins.0.get("updater")) {
        app.plugin(tauri_plugin_updater::Builder::new().build())?;
        app.state::<Updates>().enabled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// The status a surface should show now: the last one shown, or the
/// build's resting state before anything has run.
fn current(app: &AppHandle) -> Status {
    let updates = app.state::<Updates>();
    let shown = updates.status.lock().unwrap().clone();
    shown.unwrap_or_else(|| {
        if updates.enabled.load(Ordering::SeqCst) {
            Status::Idle
        } else {
            Status::Disabled
        }
    })
}

/// The tray's "Check for Updates…" item, disabled when updates are off.
pub fn menu_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let updates = app.state::<Updates>();
    let status = current(app);
    let (text, enabled) = label(&status);
    let item = MenuItem::with_id(app, MENU_ID, text, enabled, None::<&str>)?;
    *updates.item.lock().unwrap() = Some(item.clone());
    *updates.status.lock().unwrap() = Some(status);
    Ok(item)
}

fn show(app: &AppHandle, status: Status) {
    let updates = app.state::<Updates>();
    *updates.status.lock().unwrap() = Some(status.clone());
    if let Some(item) = updates.item.lock().unwrap().as_ref() {
        let (text, enabled) = label(&status);
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    }
    let _ = app.emit("update-status", payload(&status));
}

/// The panel's read of the status the tray item shows.
#[tauri::command]
pub fn update_status(app: AppHandle) -> Value {
    payload(&current(&app))
}

/// The panel's update action performs the same click as the tray item.
#[tauri::command]
pub fn update_action(app: AppHandle) {
    on_click(&app);
}

/// Checks once at startup. A failure here stays quiet (the user may be
/// offline); the tray item still offers a manual check.
pub fn check_at_startup(app: &AppHandle) {
    run(app, true);
}

/// The tray item was clicked: install a found update, or check for one.
pub fn on_click(app: &AppHandle) {
    run(app, false);
}

fn run(app: &AppHandle, quiet: bool) {
    let updates = app.state::<Updates>();
    if !updates.enabled.load(Ordering::SeqCst) {
        return;
    }
    // An installed update restarts on the next click: the recovery when a
    // requested restart was vetoed. Never behind `busy`; nothing may block it.
    if matches!(*updates.phase.lock().unwrap(), Phase::Installed) {
        // A main-thread restart skips the Exit event, so stop the bridge here.
        crate::bridge::stop(app);
        app.restart();
    }
    if updates.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let pending = match std::mem::replace(&mut *updates.phase.lock().unwrap(), Phase::None) {
        Phase::Pending(update) => Some(*update),
        _ => None,
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match pending {
            Some(update) => install(&app, update).await,
            None => check(&app, quiet).await,
        }
        app.state::<Updates>().busy.store(false, Ordering::SeqCst);
    });
}

async fn check(app: &AppHandle, quiet: bool) {
    show(app, Status::Checking);
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    match found {
        Ok(Some(update)) => {
            let status = Status::Available(update.version.clone());
            *app.state::<Updates>().phase.lock().unwrap() = Phase::Pending(Box::new(update));
            show(app, status);
        }
        Ok(None) => show(
            app,
            if quiet {
                Status::Idle
            } else {
                Status::UpToDate
            },
        ),
        Err(error) => {
            eprintln!("update check failed: {error}");
            show(app, if quiet { Status::Idle } else { Status::Failed });
        }
    }
}

async fn install(app: &AppHandle, update: Update) {
    let version = update.version.clone();
    show(app, Status::Installing(version.clone()));
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            // The restart is requested so the exit path stops the bridge. If
            // the request is ever vetoed, the Installed phase keeps a
            // clickable "restart to finish" item rather than a stuck
            // "Installing…".
            *app.state::<Updates>().phase.lock().unwrap() = Phase::Installed;
            show(app, Status::ReadyToRestart(version));
            app.request_restart();
        }
        Err(error) => {
            eprintln!("update install failed: {error}");
            show(app, Status::Failed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn updates_need_a_key_and_an_endpoint() {
        assert!(!configured(None));
        assert!(!configured(Some(&json!({}))));
        assert!(!configured(Some(
            &json!({ "pubkey": "k", "endpoints": [] })
        )));
        assert!(!configured(Some(
            &json!({ "pubkey": " ", "endpoints": ["https://x"] })
        )));
        assert!(!configured(Some(&json!({ "endpoints": ["https://x"] }))));
        assert!(configured(Some(
            &json!({ "pubkey": "k", "endpoints": ["https://x"] })
        )));
    }

    #[test]
    fn only_settled_states_are_clickable() {
        assert!(!label(&Status::Disabled).1);
        assert!(!label(&Status::Checking).1);
        assert!(!label(&Status::Installing("1.2.3".into())).1);
        assert_eq!(label(&Status::Idle), ("Check for Updates…".into(), true));
        assert!(label(&Status::UpToDate).1);
        assert!(label(&Status::Failed).1);
        let (text, enabled) = label(&Status::Available("1.2.3".into()));
        assert!(enabled && text.contains("1.2.3"));
        let (text, enabled) = label(&Status::ReadyToRestart("1.2.3".into()));
        assert!(enabled && text.contains("1.2.3") && text.contains("Restart"));
    }

    #[test]
    fn the_panel_reads_the_same_status_as_the_tray() {
        assert_eq!(
            payload(&Status::Idle),
            json!({ "state": "idle", "version": null })
        );
        assert_eq!(
            payload(&Status::Disabled),
            json!({ "state": "disabled", "version": null })
        );
        assert_eq!(
            payload(&Status::Failed),
            json!({ "state": "failed", "version": null })
        );
        assert_eq!(
            payload(&Status::Available("1.2.3".into())),
            json!({ "state": "available", "version": "1.2.3" })
        );
        assert_eq!(
            payload(&Status::Installing("1.2.3".into())),
            json!({ "state": "installing", "version": "1.2.3" })
        );
        assert_eq!(
            payload(&Status::ReadyToRestart("1.2.3".into())),
            json!({ "state": "ready-to-restart", "version": "1.2.3" })
        );
    }
}
