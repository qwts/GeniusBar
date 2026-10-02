//! Updates from this repository's GitHub releases (ADR-0004 decision 6).
//! The updater's public key and endpoint are release configuration passed
//! at build time (decision 8); a build without them runs with updates off.
//! Checks run here, at startup and from the tray, so the web view needs no
//! updater permissions.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde_json::Value;
use tauri::{menu::MenuItem, AppHandle, Manager, Wry};
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

/// What the tray item shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Disabled,
    Idle,
    Checking,
    UpToDate,
    Available(String),
    Installing(String),
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
        Status::Failed => ("Update Failed — Try Again".into(), true),
    }
}

#[derive(Default)]
pub struct Updates {
    /// Set once the plugin is registered.
    enabled: AtomicBool,
    /// A check or install is running; further clicks wait for it.
    busy: AtomicBool,
    /// An update found by a check, installed by the next click.
    pending: Mutex<Option<Update>>,
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

/// The tray's "Check for Updates…" item, disabled when updates are off.
pub fn menu_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let updates = app.state::<Updates>();
    let status = if updates.enabled.load(Ordering::SeqCst) {
        Status::Idle
    } else {
        Status::Disabled
    };
    let (text, enabled) = label(&status);
    let item = MenuItem::with_id(app, MENU_ID, text, enabled, None::<&str>)?;
    *updates.item.lock().unwrap() = Some(item.clone());
    Ok(item)
}

fn show(app: &AppHandle, status: &Status) {
    if let Some(item) = app.state::<Updates>().item.lock().unwrap().as_ref() {
        let (text, enabled) = label(status);
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    }
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
    if !updates.enabled.load(Ordering::SeqCst) || updates.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let pending = updates.pending.lock().unwrap().take();
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
    show(app, &Status::Checking);
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    match found {
        Ok(Some(update)) => {
            let status = Status::Available(update.version.clone());
            *app.state::<Updates>().pending.lock().unwrap() = Some(update);
            show(app, &status);
        }
        Ok(None) => show(
            app,
            if quiet {
                &Status::Idle
            } else {
                &Status::UpToDate
            },
        ),
        Err(error) => {
            eprintln!("update check failed: {error}");
            show(
                app,
                if quiet {
                    &Status::Idle
                } else {
                    &Status::Failed
                },
            );
        }
    }
}

async fn install(app: &AppHandle, update: Update) {
    show(app, &Status::Installing(update.version.clone()));
    match update.download_and_install(|_, _| {}, || {}).await {
        // A requested restart runs the exit path, so the bridge stops first.
        Ok(()) => app.request_restart(),
        Err(error) => {
            eprintln!("update install failed: {error}");
            show(app, &Status::Failed);
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
    }
}
