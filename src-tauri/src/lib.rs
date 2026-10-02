//! GeniusBar's shell (ADR-0004 decision 2): the tray item, the popup
//! anchored to it, and platform calls. Agent logic stays out of Rust; it
//! reaches agent-comms through the Node bridge (#7).

mod bridge;
mod snapshot;
mod updates;

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Manager, RunEvent, WebviewWindow, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

/// How the app presents itself, chosen from the command line as in R1.
#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    /// The normal menubar/tray item with a popup.
    Tray,
    /// `--window`: the same UI in a regular titled window, for automation.
    Window,
    /// `--snapshot PATH [--snapshot-detail ID]`: render the popup to a PNG
    /// and exit, never showing a window (#6).
    Snapshot {
        path: PathBuf,
        detail: Option<String>,
    },
}

/// Parses the launch flags as R1's `parseLaunchOptions` did. Snapshot wins
/// over `--window`; a flag missing its value is a usage error.
pub fn parse_mode<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Result<Mode, String> {
    let (mut window, mut path, mut detail) = (false, None, None);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |flag: &str| {
            args.next()
                .map(|v| v.as_ref().to_owned())
                .filter(|v| !v.is_empty() && !v.starts_with("--"))
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match arg.as_ref() {
            "--window" => window = true,
            "--snapshot" => path = Some(PathBuf::from(value("--snapshot")?)),
            "--snapshot-detail" => detail = Some(value("--snapshot-detail")?),
            _ => {}
        }
    }
    match (path, detail) {
        (Some(path), detail) => Ok(Mode::Snapshot { path, detail }),
        (None, Some(_)) => Err("--snapshot-detail needs --snapshot".into()),
        (None, None) if window => Ok(Mode::Window),
        (None, None) => Ok(Mode::Tray),
    }
}

/// A tray click that arrives this soon after the popup hid for losing focus
/// is the click that took the focus: it closes the popup, not reopens it.
const DISMISS_GRACE: Duration = Duration::from_millis(300);

/// When the popup last hid because it lost focus.
#[derive(Default)]
struct Dismissed(Mutex<Option<Instant>>);

impl Dismissed {
    fn record(&self, at: Instant) {
        *self.0.lock().unwrap() = Some(at);
    }

    /// True if a click at `at` follows a focus-loss hide within the grace
    /// period. The record is consumed either way.
    fn just_dismissed(&self, at: Instant) -> bool {
        self.0
            .lock()
            .unwrap()
            .take()
            .is_some_and(|hidden| at.saturating_duration_since(hidden) < DISMISS_GRACE)
    }
}

fn toggle_popup(window: &WebviewWindow) {
    let dismissed = window.state::<Dismissed>();
    if dismissed.just_dismissed(Instant::now()) {
        return;
    }
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.move_window(Position::TrayCenter);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_window_mode(app: &mut App, window: &WebviewWindow) -> tauri::Result<()> {
    // The bundle sets LSUIElement, so a window needs a regular activation
    // policy to get a Dock icon and keyboard focus.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = app;
    window.set_decorations(true)?;
    window.set_always_on_top(false)?;
    window.set_skip_taskbar(false)?;
    window.set_resizable(true)?;
    window.center()?;
    window.show()?;
    window.set_focus()
}

fn install_tray(app: &mut App, window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let check = updates::menu_item(app.handle())?;
    let quit = MenuItem::with_id(app, "quit", "Quit GeniusBar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&check, &quit])?;
    TrayIconBuilder::with_id("geniusbar")
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("GeniusBar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                app.exit(0);
            } else if event.id() == updates::MENU_ID {
                updates::on_click(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    toggle_popup(&window);
                }
            }
        })
        .build(app)?;
    updates::check_at_startup(app.handle());
    // A popup closes when the user clicks elsewhere, like a menu.
    let popup = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if popup.is_visible().unwrap_or(false) {
                popup.state::<Dismissed>().record(Instant::now());
            }
            let _ = popup.hide();
        }
    });
    Ok(())
}

pub fn run() {
    let mode = parse_mode(std::env::args().skip(1)).unwrap_or_else(|error| {
        eprintln!("geniusbar: {error}");
        std::process::exit(2);
    });
    let snapshot = match &mode {
        Mode::Snapshot { path, detail } => Some((path.clone(), detail.clone())),
        _ => None,
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_shell::init())
        .manage(bridge::Bridge::default())
        .manage(Dismissed::default())
        .manage(updates::Updates::default())
        .manage(snapshot::SnapshotRequest(snapshot))
        .invoke_handler(tauri::generate_handler![
            bridge::bridge,
            bridge::setup,
            bridge::remove_services,
            snapshot::snapshot_options,
            snapshot::snapshot_write
        ])
        .setup(move |app| {
            bridge::start(app.handle().clone());
            let window = app
                .get_webview_window("main")
                .expect("tauri.conf.json defines the main window");
            match mode {
                Mode::Window => show_window_mode(app, &window)?,
                Mode::Tray => install_tray(app, &window)?,
                Mode::Snapshot { .. } => {
                    // No tray, no updater, no service changes: render and exit.
                    #[cfg(target_os = "macos")]
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    snapshot::arm_deadline(app.handle().clone());
                    return Ok(());
                }
            }
            bridge::refresh_services(app.handle().clone());
            updates::init(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("GeniusBar failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                bridge::stop(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_is_the_default() {
        assert_eq!(parse_mode(Vec::<String>::new()), Ok(Mode::Tray));
        assert_eq!(parse_mode(["--other"]), Ok(Mode::Tray));
    }

    #[test]
    fn snapshot_flags_take_values_and_win_over_window() {
        assert_eq!(
            parse_mode(["--window", "--snapshot", "/tmp/g.png"]),
            Ok(Mode::Snapshot {
                path: "/tmp/g.png".into(),
                detail: None
            })
        );
        assert_eq!(
            parse_mode(["--snapshot-detail", "agent_c", "--snapshot", "out.png"]),
            Ok(Mode::Snapshot {
                path: "out.png".into(),
                detail: Some("agent_c".into())
            })
        );
        assert!(parse_mode(["--snapshot"]).is_err());
        assert!(parse_mode(["--snapshot", "--window"]).is_err());
        assert!(parse_mode(["--snapshot-detail", "agent_c"]).is_err());
    }

    #[test]
    fn a_click_right_after_a_focus_hide_keeps_the_popup_closed() {
        let dismissed = Dismissed::default();
        let hidden = Instant::now();
        dismissed.record(hidden);
        assert!(dismissed.just_dismissed(hidden + Duration::from_millis(50)));
        // Consumed: the next click toggles normally.
        assert!(!dismissed.just_dismissed(hidden + Duration::from_millis(60)));
        dismissed.record(hidden);
        assert!(!dismissed.just_dismissed(hidden + DISMISS_GRACE));
    }

    #[test]
    fn window_flag_selects_window_mode() {
        assert_eq!(parse_mode(["--window"]), Ok(Mode::Window));
        assert_eq!(parse_mode(["--x", "--window"]), Ok(Mode::Window));
    }
}
