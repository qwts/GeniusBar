//! GeniusBar's shell (ADR-0004 decision 2): the tray item, the popup
//! anchored to it, and platform calls. Agent logic stays out of Rust; it
//! reaches agent-comms through the Node bridge (#7).

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

/// How the app presents itself, chosen from the command line as in R1.
#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    /// The normal menubar/tray item with a popup.
    Tray,
    /// `--window`: the same UI in a regular titled window, for automation.
    Window,
}

pub fn parse_mode<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Mode {
    if args.into_iter().any(|arg| arg.as_ref() == "--window") {
        Mode::Window
    } else {
        Mode::Tray
    }
}

fn toggle_popup(window: &WebviewWindow) {
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
    let quit = MenuItem::with_id(app, "quit", "Quit GeniusBar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    TrayIconBuilder::with_id("geniusbar")
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("GeniusBar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                app.exit(0);
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
    // A popup closes when the user clicks elsewhere, like a menu.
    let popup = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = popup.hide();
        }
    });
    Ok(())
}

pub fn run() {
    let mode = parse_mode(std::env::args().skip(1));
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .expect("tauri.conf.json defines the main window");
            match mode {
                Mode::Window => show_window_mode(app, &window)?,
                Mode::Tray => install_tray(app, &window)?,
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("GeniusBar failed to start");
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
    fn window_flag_selects_window_mode() {
        assert_eq!(parse_mode(["--window"]), Mode::Window);
        assert_eq!(parse_mode(["--x", "--window"]), Mode::Window);
    }
}
