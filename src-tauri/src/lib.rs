//! GeniusBar's shell (ADR-0004 decision 2): the tray item, the popup
//! anchored to it, and platform calls. Agent logic stays out of Rust; it
//! reaches agent-comms through the Node bridge (#7).

mod bridge;
mod snapshot;
mod soul_package;
mod starter;
mod updates;

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Emitter, Manager, RunEvent, WebviewWindow, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

/// How the app presents itself, chosen from the command line as in R1.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Mode {
    /// The normal menubar/tray item with a popup.
    Tray,
    /// `--window`: the same UI in a regular titled window, for automation.
    Window,
    /// `--snapshot PATH [--snapshot-detail AGENT_ID]`: the popup rendered
    /// to a PNG with no window shown, then exit (#6).
    Snapshot(snapshot::Request),
}

/// Reads the launch flags as R1's `parseLaunchOptions` did: a flag takes
/// the next argument or `=value`, a flag missing its value is ignored,
/// unknown arguments are ignored, and `--snapshot` wins over `--window`.
pub fn parse_mode<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Mode {
    let args: Vec<S> = args.into_iter().collect();
    let mut path = None;
    let mut detail = None;
    let mut window = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_ref();
        let next = args
            .get(index + 1)
            .map(AsRef::as_ref)
            .filter(|next| !next.starts_with("--"));
        index += 1;
        if arg == "--window" {
            window = true;
        } else if let Some(value) = flag_value(arg, next, "--snapshot") {
            index += usize::from(!arg.contains('='));
            path = Some(value).filter(|v| !v.is_empty()).or(path);
        } else if let Some(value) = flag_value(arg, next, "--snapshot-detail") {
            index += usize::from(!arg.contains('='));
            detail = Some(value).filter(|v| !v.is_empty()).or(detail);
        }
    }
    match path {
        Some(path) => Mode::Snapshot(snapshot::Request {
            path: path.into(),
            detail: detail.map(str::to_owned),
        }),
        None if window => Mode::Window,
        None => Mode::Tray,
    }
}

/// `FLAG VALUE` or `FLAG=VALUE`; None when `arg` is not `flag` or lacks a value.
fn flag_value<'a>(arg: &'a str, next: Option<&'a str>, flag: &str) -> Option<&'a str> {
    match arg.strip_prefix(flag)? {
        "" => next,
        rest => rest.strip_prefix('='),
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

/// Snapshot mode keeps the popup hidden: no Dock icon, no tray, nothing
/// shown. It also starts no service refresh or update check, so it only
/// reads.
fn start_snapshot(app: &mut App, window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let _ = app;
    snapshot::start(window.clone());
}

pub fn run() {
    let mode = parse_mode(std::env::args().skip(1));
    let tray_mode = mode == Mode::Tray;
    let snapshot = match &mode {
        Mode::Snapshot(request) => Some(request.clone()),
        _ => None,
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_shell::init())
        .manage(bridge::Bridge::default())
        .manage(soul_package::PendingSoulPackages::default())
        .manage(Dismissed::default())
        .manage(updates::Updates::default())
        .manage(snapshot::Snapshot::new(snapshot))
        .invoke_handler(tauri::generate_handler![
            bridge::bridge,
            bridge::setup,
            bridge::remove_services,
            starter::starter_soul,
            soul_package::take_opened_soul_packages,
            soul_package::validate_soul_package,
            starter::install_dev_tools,
            bridge::harness_auth,
            updates::update_status,
            updates::update_action,
            snapshot::snapshot_options,
            snapshot::snapshot_ready
        ])
        .setup(move |app| {
            bridge::start(app.handle().clone());
            if !matches!(mode, Mode::Snapshot(_)) {
                bridge::refresh_services(app.handle().clone());
            }
            updates::init(app.handle())?;
            let window = app
                .get_webview_window("main")
                .expect("tauri.conf.json defines the main window");
            match mode {
                Mode::Window => show_window_mode(app, &window)?,
                Mode::Tray => install_tray(app, &window)?,
                Mode::Snapshot(_) => start_snapshot(app, &window),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("GeniusBar failed to start")
        .run(move |app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                let opened = app
                    .state::<soul_package::PendingSoulPackages>()
                    .enqueue_urls(urls);
                if !opened.is_empty() {
                    let _ = app.emit("soul-package-opened", ());
                    if let Some(window) = app.get_webview_window("main") {
                        if tray_mode {
                            let _ = window.move_window(Position::TrayCenter);
                        }
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
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
        assert_eq!(parse_mode(Vec::<String>::new()), Mode::Tray);
        assert_eq!(parse_mode(["--other"]), Mode::Tray);
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
        assert_eq!(parse_mode(["--window"]), Mode::Window);
        assert_eq!(parse_mode(["--x", "--window"]), Mode::Window);
    }

    fn snapshot(path: &str, detail: Option<&str>) -> Mode {
        Mode::Snapshot(snapshot::Request {
            path: path.into(),
            detail: detail.map(str::to_owned),
        })
    }

    #[test]
    fn snapshot_flag_takes_a_path() {
        assert_eq!(
            parse_mode(["--snapshot", "/tmp/a.png"]),
            snapshot("/tmp/a.png", None)
        );
        assert_eq!(
            parse_mode(["--snapshot=/tmp/a.png"]),
            snapshot("/tmp/a.png", None)
        );
        // Snapshot wins over --window, in either order.
        assert_eq!(
            parse_mode(["--window", "--snapshot", "a.png"]),
            snapshot("a.png", None)
        );
        assert_eq!(
            parse_mode(["--snapshot", "a.png", "--window"]),
            snapshot("a.png", None)
        );
    }

    #[test]
    fn snapshot_detail_names_a_soul() {
        assert_eq!(
            parse_mode(["--snapshot", "a.png", "--snapshot-detail", "agent_1"]),
            snapshot("a.png", Some("agent_1"))
        );
        assert_eq!(
            parse_mode(["--snapshot-detail=agent_1", "--snapshot=a.png"]),
            snapshot("a.png", Some("agent_1"))
        );
        // A detail without a snapshot is ignored.
        assert_eq!(parse_mode(["--snapshot-detail", "agent_1"]), Mode::Tray);
    }

    #[test]
    fn a_flag_missing_its_value_is_ignored() {
        assert_eq!(parse_mode(["--snapshot"]), Mode::Tray);
        assert_eq!(parse_mode(["--snapshot="]), Mode::Tray);
        assert_eq!(parse_mode(["--snapshot", "--window"]), Mode::Window);
        assert_eq!(
            parse_mode(["--snapshot", "a.png", "--snapshot-detail", "--x"]),
            snapshot("a.png", None)
        );
        assert_eq!(
            parse_mode(["--snapshot", "a.png", "--snapshot-detail="]),
            snapshot("a.png", None)
        );
        // Lookalike flags are not these flags.
        assert_eq!(parse_mode(["--snapshots", "a.png"]), Mode::Tray);
    }
}
