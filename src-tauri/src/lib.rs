//! GeniusBar's shell (ADR-0004 decision 2): the tray item, the popup
//! anchored to it, and platform calls. Agent logic stays out of Rust; it
//! reaches agent-comms through the Node bridge (#7).

mod bridge;
mod snapshot;
mod soul_package;
mod starter;
mod tray;
mod updates;
mod windows;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
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

impl Mode {
    /// Whether this launch takes the single-instance lock (#61). The tray
    /// app and `--window` do, so a second launch shows the running copy
    /// instead of starting another tray item and bridge. A snapshot does
    /// not: test tooling runs one beside the tray app with `open -n`, and
    /// it must neither be turned away nor take the lock from the tray app.
    pub fn single_instance(&self) -> bool {
        !matches!(self, Mode::Snapshot(_))
    }

    /// The name the web view branches on: the popup, or the desktop. A
    /// snapshot draws the popup, so it names that.
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Tray | Mode::Snapshot(_) => "tray",
            Mode::Window => "window",
        }
    }
}

/// The label of the companion desktop window opened from the tray (#69).
const DESKTOP_LABEL: &str = "desktop";

/// The tray menu's "Open Desktop" item.
const OPEN_DESKTOP_MENU_ID: &str = "open-desktop";

/// The tray menu's Quit item.
const QUIT_MENU_ID: &str = "quit";

/// The layout a window draws (#69): the desktop window always draws the
/// desktop; `main` draws what the launch chose, so `--window` keeps working.
fn mode_for_label(label: &str, process: &Mode) -> &'static str {
    if label == DESKTOP_LABEL {
        Mode::Window.as_str()
    } else {
        process.as_str()
    }
}

/// Which layout the calling web view draws; the mode stays the shell's choice.
#[tauri::command]
fn app_mode(window: WebviewWindow, mode: tauri::State<'_, Mode>) -> &'static str {
    mode_for_label(window.label(), &mode)
}

/// Opens the companion desktop beside the tray popup, or focuses it (#69).
/// Async so the window is not built on the IPC thread (a Windows deadlock).
#[tauri::command]
async fn open_desktop(app: tauri::AppHandle) -> Result<(), String> {
    open_desktop_window(&app).map_err(|error| error.to_string())
}

/// Opens the `desktop` window, or brings back the one already open. Under
/// `--window` the main window is the desktop already, so it shows that.
fn open_desktop_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if *app.state::<Mode>() != Mode::Tray {
        reveal_main_window(app);
        return Ok(());
    }
    if let Some(popup) = app.get_webview_window("main") {
        let _ = popup.hide();
    }
    if let Some(window) = app.get_webview_window(DESKTOP_LABEL) {
        let _ = window.unminimize();
        window.show()?;
        return window.set_focus();
    }
    // A window needs the regular policy for a Dock icon and keyboard focus;
    // the tray app goes back to an accessory when the window closes.
    // Windows has no activation policy: the taskbar entry follows the window.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)?;
    let window = WebviewWindowBuilder::new(app, DESKTOP_LABEL, WebviewUrl::default())
        .title("GeniusBar")
        .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .center()
        .focused(true)
        .build();
    let window = match window {
        Ok(window) => window,
        Err(error) => {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            return Err(error);
        }
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            // Closing the desktop leaves the tray app running (see the
            // ExitRequested handler) and takes its Dock icon away, unless
            // a session or other surface window still needs it (#223).
            #[cfg(target_os = "macos")]
            if !handle.state::<windows::Documents>().any() {
                let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let _ = &handle;
        }
    });
    window.set_focus()
}

/// The desktop's size in window mode; the popup keeps tauri.conf.json's.
const WINDOW_SIZE: (f64, f64) = (1100.0, 720.0);

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

/// "Close GeniusBar when clicking outside it" (#265): whether the popup
/// hides when it loses focus, as a menu does. Off until the popup's page
/// sends the stored choice, so a drag from Finder reaches the popup.
#[derive(Default)]
pub struct PopupAutohide(AtomicBool);

impl PopupAutohide {
    fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// The popup's page sends the stored choice as it starts and as it changes.
#[tauri::command]
fn set_popup_autohide(app: tauri::AppHandle, on: bool) {
    app.state::<PopupAutohide>().0.store(on, Ordering::Relaxed);
    windows::log_line(
        &app,
        &format!("popup autohide {}", if on { "on" } else { "off" }),
    );
}

/// Whether losing focus hides the popup: only when asked to, and only a
/// showing popup (a hidden one has nothing to do, and must not note a
/// dismissal that the next tray click would then swallow).
pub fn hides_on_blur(autohide: bool, visible: bool) -> bool {
    autohide && visible
}

/// The popup's smallest size (tauri.conf.json's minWidth / minHeight).
const POPUP_MIN: (f64, f64) = (320.0, 320.0);

/// The popup's size for this launch (#264): the one it was last resized to,
/// else the design's from tauri.conf.json.
fn popup_size(remembered: Option<windows::Frame>, configured: (f64, f64)) -> (f64, f64) {
    match remembered {
        Some(frame) => (frame.width.max(POPUP_MIN.0), frame.height.max(POPUP_MIN.1)),
        None => configured,
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

/// Brings the main window forward: the popup under the tray item in tray
/// mode, the desktop window as it is otherwise.
fn reveal_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if *app.state::<Mode>() == Mode::Tray {
        let _ = window.move_window(Position::TrayCenter);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Queues the `.soul` packages among `urls` for the web view and shows
/// the window that will offer them. Other files are ignored. True when
/// there was a package to offer.
fn open_soul_packages<R: tauri::Runtime>(app: &tauri::AppHandle<R>, urls: &[tauri::Url]) -> bool {
    let opened = app
        .state::<soul_package::PendingSoulPackages>()
        .enqueue_urls(urls);
    if opened.is_empty() {
        return false;
    }
    let _ = app.emit("soul-package-opened", ());
    reveal_main_window(app);
    true
}

/// A second launch of the tray app or `--window` (#61): the running copy
/// shows itself and takes any `.soul` package named on the second launch's
/// command line; the plugin then exits the second copy.
fn on_second_instance<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    argv: Vec<String>,
    cwd: String,
) {
    let urls = soul_package::argv_urls(argv.iter().skip(1), std::path::Path::new(&cwd));
    // A package goes to the popup; otherwise a relaunch while the desktop
    // is open brings that window back, and the popup shows as before.
    if open_soul_packages(app, &urls) {
        return;
    }
    if app.get_webview_window(DESKTOP_LABEL).is_some() {
        let _ = open_desktop_window(app);
    } else {
        reveal_main_window(app);
    }
}

fn show_window_mode(app: &mut App, window: &WebviewWindow) -> tauri::Result<()> {
    // The bundle sets LSUIElement, so a window needs a regular activation
    // policy to get a Dock icon and keyboard focus (nothing to set on
    // Windows: a shown window is in the taskbar).
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = app;
    window.set_decorations(true)?;
    window.set_always_on_top(false)?;
    window.set_skip_taskbar(false)?;
    window.set_resizable(true)?;
    window.set_size(tauri::LogicalSize::new(WINDOW_SIZE.0, WINDOW_SIZE.1))?;
    window.center()?;
    window.show()?;
    window.set_focus()
}

fn install_tray(app: &mut App, window: &WebviewWindow) -> tauri::Result<()> {
    // No Dock icon on macOS; on Windows the hidden popup has no taskbar
    // entry anyway, so there is no policy to set.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let desktop = MenuItem::with_id(
        app,
        OPEN_DESKTOP_MENU_ID,
        "Open Desktop",
        true,
        None::<&str>,
    )?;
    let check = updates::menu_item(app.handle())?;
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit GeniusBar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&desktop, &check, &quit])?;
    TrayIconBuilder::with_id(tray::TRAY_ID)
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("GeniusBar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                app.exit(0);
            } else if event.id() == OPEN_DESKTOP_MENU_ID {
                let _ = open_desktop_window(app);
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
    // The popup keeps the size it was last resized to (#264).
    let remembered = app.state::<windows::Frames>().get("main");
    if let Some((width, height)) = remembered.map(|frame| popup_size(Some(frame), (0.0, 0.0))) {
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
    }
    // A popup closes when the user clicks elsewhere, like a menu, once
    // asked to (#265); by default it stays until the tray icon is clicked.
    let popup = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            let visible = popup.is_visible().unwrap_or(false);
            if hides_on_blur(popup.state::<PopupAutohide>().get(), visible) {
                popup.state::<Dismissed>().record(Instant::now());
                let _ = popup.hide();
            }
        }
        WindowEvent::Resized(_) => {
            if let Some(frame) = windows::frame_of(&popup) {
                popup.state::<windows::Frames>().record("main", frame);
            }
        }
        _ => {}
    });
    Ok(())
}

/// Snapshot mode keeps the popup hidden: no Dock icon, no tray, nothing
/// shown. It also starts no service refresh or update check, so it only
/// reads.
fn start_snapshot(app: &mut App, window: &WebviewWindow) {
    // Windows has no activation policy; the window simply stays hidden.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let _ = app;
    snapshot::start(window.clone());
}

pub fn run() {
    let mode = parse_mode(std::env::args().skip(1));
    let snapshot_mode = matches!(mode, Mode::Snapshot(_));
    let tray_mode = mode == Mode::Tray;
    let snapshot = match &mode {
        Mode::Snapshot(request) => Some(request.clone()),
        _ => None,
    };
    let mut builder = tauri::Builder::default();
    // The single-instance plugin must be registered before any other.
    if mode.single_instance() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            on_second_instance(app, argv, cwd)
        }));
    }
    builder
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_shell::init())
        .manage(bridge::Bridge::default())
        .manage(bridge::IdentityJobs::default())
        .manage(bridge::PreparedRevisions::default())
        .manage(soul_package::PendingSoulPackages::default())
        .manage(Dismissed::default())
        .manage(PopupAutohide::default())
        .manage(windows::Frames::default())
        .manage(updates::Updates::default())
        .manage(windows::Documents::default())
        // A copy: the closure below matches on the original.
        .manage(mode.clone())
        .manage(snapshot::Snapshot::new(snapshot))
        .invoke_handler(tauri::generate_handler![
            app_mode,
            open_desktop,
            set_popup_autohide,
            windows::open_surface,
            windows::sync_team_windows,
            windows::sync_perimeter,
            windows::shell_log,
            bridge::bridge,
            bridge::setup,
            bridge::remove_services,
            bridge::inspect_services,
            bridge::migrate_services,
            bridge::cli_tools,
            starter::starter_soul,
            soul_package::take_opened_soul_packages,
            soul_package::validate_soul_package,
            starter::install_dev_tools,
            bridge::harness_auth,
            bridge::runtime_metrics,
            bridge::soul_comms,
            bridge::locate_soul_package,
            bridge::soul_asides,
            bridge::approvals,
            bridge::audit_list,
            bridge::soul_cold_wake,
            bridge::soul_population,
            bridge::soul_mode,
            bridge::soul_model,
            bridge::soul_stop,
            bridge::soul_stop_probe,
            bridge::soul_pause,
            bridge::soul_resume,
            bridge::soul_pause_probe,
            bridge::soul_computer_use,
            bridge::soul_computer_use_probe,
            bridge::sandbox_status,
            bridge::sandbox_set,
            bridge::sandbox_override,
            bridge::sandbox_pairings,
            bridge::sandbox_approve,
            bridge::list_soul_templates,
            bridge::soul_profile,
            bridge::soul_profile_file,
            bridge::soul_env,
            bridge::soul_revision_prepare,
            bridge::soul_revision_discard,
            bridge::soul_revision_edit,
            bridge::soul_remove,
            bridge::daemon_status,
            bridge::services_installed,
            bridge::population_list,
            bridge::identity_apps_list,
            bridge::identity_app_create,
            bridge::identity_app_create_status,
            bridge::identity_app_create_cancel,
            bridge::identity_app_create_pending,
            bridge::identity_app_connect,
            bridge::identity_app_rotate_key,
            bridge::identity_app_assign,
            bridge::identity_app_remove,
            bridge::identity_addon_set,
            bridge::identity_app_open,
            tray::set_tray_badge,
            updates::update_status,
            updates::update_action,
            snapshot::snapshot_options,
            snapshot::snapshot_ready
        ])
        .setup(move |app| {
            windows::log_line(
                app.handle(),
                &format!("launch {} {:?}", app.package_info().version, mode),
            );
            bridge::start(app.handle().clone());
            if !matches!(mode, Mode::Snapshot(_)) {
                bridge::refresh_services(app.handle().clone());
                // App creates a previous launch left waiting on GitHub (#67).
                bridge::IdentityJobs::reattach(app.handle());
            }
            updates::init(app.handle())?;
            windows::load_frames(app.handle());
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
            // A snapshot stays hidden and read-only: a package opened from
            // Finder meanwhile is left for the next normal launch.
            #[cfg(target_os = "macos")]
            if let (false, RunEvent::Opened { urls }) = (snapshot_mode, &event) {
                open_soul_packages(app, urls);
            }
            // Windows opens a `.soul` through the installer's file
            // association, which is a second launch (`on_second_instance`),
            // not an event.
            #[cfg(not(target_os = "macos"))]
            let _ = snapshot_mode;
            // The Dock icon (shown while the desktop is open) or a relaunch
            // from Finder opens or focuses the desktop (#69); a relaunch on
            // Windows reaches `on_second_instance` instead.
            #[cfg(target_os = "macos")]
            if let (true, RunEvent::Reopen { .. }) = (tray_mode, &event) {
                let _ = open_desktop_window(app);
            }
            // Closing the desktop window is not quitting: the tray stays.
            // Quit (app.exit) carries a code and still exits.
            if let (
                true,
                RunEvent::ExitRequested {
                    code: None, api, ..
                },
            ) = (tray_mode, &event)
            {
                api.prevent_exit();
            }
            if let RunEvent::Exit = event {
                windows::save_frames(app);
                bridge::stop(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_window_draws_the_desktop_and_main_follows_the_launch() {
        assert_eq!(mode_for_label(DESKTOP_LABEL, &Mode::Tray), "window");
        assert_eq!(mode_for_label("main", &Mode::Tray), "tray");
        assert_eq!(mode_for_label("main", &Mode::Window), "window");
        assert_eq!(mode_for_label("main", &snapshot("a.png", None)), "tray");
    }

    #[test]
    fn tray_menu_ids_are_distinct() {
        let ids = [OPEN_DESKTOP_MENU_ID, updates::MENU_ID, QUIT_MENU_ID];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

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
    fn the_popup_hides_on_blur_only_when_asked_and_showing() {
        assert!(!hides_on_blur(false, true));
        assert!(!hides_on_blur(false, false));
        assert!(hides_on_blur(true, true));
        assert!(!hides_on_blur(true, false));
        assert!(!PopupAutohide::default().get());
    }

    #[test]
    fn the_popup_keeps_its_last_size_within_its_minimum() {
        let frame = |width, height| {
            Some(windows::Frame {
                x: 0.0,
                y: 0.0,
                width,
                height,
            })
        };
        assert_eq!(popup_size(None, (384.0, 560.0)), (384.0, 560.0));
        assert_eq!(
            popup_size(frame(420.0, 700.0), (384.0, 560.0)),
            (420.0, 700.0)
        );
        assert_eq!(popup_size(frame(100.0, 100.0), (384.0, 560.0)), POPUP_MIN);
    }

    #[test]
    fn window_flag_selects_window_mode() {
        assert_eq!(parse_mode(["--window"]), Mode::Window);
        assert_eq!(parse_mode(["--x", "--window"]), Mode::Window);
        assert_eq!(Mode::Window.as_str(), "window");
        assert_eq!(Mode::Tray.as_str(), "tray");
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

    #[test]
    fn only_a_snapshot_skips_the_single_instance_guard() {
        assert!(parse_mode(Vec::<String>::new()).single_instance());
        assert!(parse_mode(["--window"]).single_instance());
        assert!(!parse_mode(["--snapshot", "a.png"]).single_instance());
        assert!(!parse_mode(["--window", "--snapshot", "a.png"]).single_instance());
        assert!(
            !parse_mode(["--snapshot", "a.png", "--snapshot-detail", "agent_1"]).single_instance()
        );
    }
}
