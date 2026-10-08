//! The native window model (#223): the design's desktop metaphor done with
//! real windows. Team cards sit on the macOS desktop as their own windows,
//! and a companion session, the audit log, Customize and Launch each open in
//! a window of their own instead of inside the popup.
//!
//! Every window loads the same page with a `surface` query that says what it
//! draws (see `ui/src/model/surface.ts`); the shell only creates, sizes and
//! places windows. The popup's web view is the coordinator: it tells the
//! shell which team windows should exist through `sync_team_windows`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::Mode;

/// A window that shows one thing in its own frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Session,
    Audit,
    Customize,
    Launch,
}

impl Surface {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "session" => Some(Self::Session),
            "audit" => Some(Self::Audit),
            "customize" => Some(Self::Customize),
            "launch" => Some(Self::Launch),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Audit => "audit",
            Self::Customize => "customize",
            Self::Launch => "launch",
        }
    }

    /// The design's window sizes, with the smallest the content still fits.
    fn size(self) -> ((f64, f64), (f64, f64)) {
        match self {
            Self::Session => ((780.0, 660.0), (520.0, 420.0)),
            Self::Audit => ((820.0, 600.0), (560.0, 400.0)),
            Self::Customize => ((720.0, 620.0), (560.0, 480.0)),
            Self::Launch => ((560.0, 680.0), (480.0, 520.0)),
        }
    }

    /// Whether the window is about one soul (its label carries the slug).
    fn per_soul(self) -> bool {
        !matches!(self, Self::Launch)
    }
}

/// The team window for a lead.
const TEAM_PREFIX: &str = "team-";

/// Where a window sat and how big it was (#264), in logical points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    /// A frame worth restoring: finite, with a size to show.
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

/// A monitor in logical points: its top-left and its size.
pub type MonitorRect = ((f64, f64), (f64, f64));

/// Whether a remembered frame still lands on a screen that is here now:
/// the window's title area (a point just inside its top-left) is on one of
/// the monitors. A frame from a monitor since unplugged is not restored.
pub fn on_screen(frame: &Frame, monitors: &[MonitorRect]) -> bool {
    let (px, py) = (frame.x + 40.0, frame.y + 20.0);
    monitors
        .iter()
        .any(|((x, y), (w, h))| px >= *x && px < x + w && py >= *y && py < y + h)
}

/// The last frame of every surface window, and the popup's size, by window
/// label (#264): a session's label carries its soul, so each companion's
/// window comes back where it was. Kept across launches in `windows.json`
/// in the app's config folder; a missing or malformed file is no frames,
/// and a frame with nothing to show is left out.
#[derive(Default)]
pub struct Frames(Mutex<HashMap<String, Frame>>);

impl Frames {
    /// The file's text back to frames; malformed text, or one bad frame, is dropped.
    pub fn parse(text: &str) -> HashMap<String, Frame> {
        serde_json::from_str::<HashMap<String, Frame>>(text)
            .map(|frames| frames.into_iter().filter(|(_, f)| f.valid()).collect())
            .unwrap_or_default()
    }

    /// The frames as the file holds them.
    pub fn to_text(frames: &HashMap<String, Frame>) -> String {
        serde_json::to_string_pretty(frames).unwrap_or_else(|_| "{}".to_string())
    }

    /// Replaces what is held with the file's contents, if it has any.
    pub fn load_from(&self, path: &Path) {
        if let Ok(text) = std::fs::read_to_string(path) {
            *self.0.lock().unwrap() = Self::parse(&text);
        }
    }

    pub fn get(&self, label: &str) -> Option<Frame> {
        self.0.lock().unwrap().get(label).copied()
    }

    /// Notes where `label` is now; an invalid frame is ignored.
    pub fn record(&self, label: &str, frame: Frame) {
        if frame.valid() {
            self.0.lock().unwrap().insert(label.to_string(), frame);
        }
    }

    /// Writes the frames to `path`, creating its folder.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = Self::to_text(&self.0.lock().unwrap());
        std::fs::write(path, text)
    }
}

/// `windows.json` in the app's config folder (`~/Library/Application
/// Support/app.geniusbar` on macOS); None when the shell has no such folder.
pub fn frames_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("windows.json"))
}

/// Writes the remembered frames; failures are logged, never raised.
pub fn save_frames<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(path) = frames_path(app) else {
        return;
    };
    if let Err(error) = app.state::<Frames>().save_to(&path) {
        log_line(app, &format!("windows.json not saved: {error}"));
    }
}

/// Reads the frames remembered by an earlier launch.
pub fn load_frames<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(path) = frames_path(app) {
        app.state::<Frames>().load_from(&path);
    }
}

/// A window's frame now, in logical points; None while the shell cannot say.
pub fn frame_of<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Option<Frame> {
    let scale = window.scale_factor().ok()?;
    let at = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Frame {
        x: at.x,
        y: at.y,
        width: size.width,
        height: size.height,
    })
}

/// The monitors here now, in logical points.
fn monitors<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<MonitorRect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let at = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            ((at.x, at.y), (size.width, size.height))
        })
        .collect()
}

/// The computer-use perimeter (#122): the orange border over the whole
/// screen, click-through, while a soul drives the screen.
pub const PERIMETER_LABEL: &str = "perimeter";
/// The pill above it that names the soul and offers Stop; it takes clicks.
pub const HALT_LABEL: &str = "halt";
/// The pill's size in points, and its gap from the top of the screen.
const HALT_SIZE: (f64, f64) = (480.0, 56.0);
const HALT_TOP: f64 = 6.0;

/// Where the perimeter and the pill go, in points, for a monitor whose
/// top-left, size and scale are given in the shell's units: the perimeter
/// covers the monitor, the pill sits centred along its top edge.
pub fn perimeter_frame(
    origin: (i32, i32),
    size: (u32, u32),
    scale: f64,
) -> ((f64, f64), (f64, f64), (f64, f64)) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let (x, y) = (f64::from(origin.0) / scale, f64::from(origin.1) / scale);
    let (w, h) = (f64::from(size.0) / scale, f64::from(size.1) / scale);
    let pill = (
        (x + (w - HALT_SIZE.0) / 2.0).round(),
        (y + HALT_TOP).round(),
    );
    ((x, y), (w, h), pill)
}

/// A short, label-safe form of a roster key (`account/agentId`): the key
/// with anything outside `[A-Za-z0-9_-]` replaced, plus a hash so two keys
/// that only differ in replaced characters still get different labels.
pub fn slug(key: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let safe: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}-{:08x}", hash >> 32)
}

/// The label of the window for `surface` (and `soul`, when it has one).
pub fn label(surface: Surface, soul: Option<&str>) -> String {
    match (surface.per_soul(), soul) {
        (true, Some(soul)) => format!("{}-{}", surface.as_str(), slug(soul)),
        _ => surface.as_str().to_string(),
    }
}

/// The page URL for a window: `index.html` plus the surface query.
pub fn page(surface: &str, params: &[(&str, Option<&str>)]) -> String {
    let mut url = format!("index.html?surface={surface}");
    for (name, value) in params {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            url.push('&');
            url.push_str(name);
            url.push('=');
            url.push_str(&encode(value));
        }
    }
    url
}

/// The script that loads `url` (from `page`) in place of an open window's
/// page. `page` percent-encodes every value, so the URL holds no quote.
pub fn navigate_script(url: &str) -> String {
    format!("window.location.replace('{url}')")
}

/// Percent-encodes a query value; unreserved characters stay readable.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// How many surface windows are open: the tray app shows a Dock icon while
/// any is, like the desktop window does (#69), and hides it again after.
#[derive(Default)]
pub struct Documents(Mutex<usize>);

impl Documents {
    fn opened(&self) -> usize {
        let mut count = self.0.lock().unwrap();
        *count += 1;
        *count
    }

    /// Whether any surface window is open.
    pub fn any(&self) -> bool {
        *self.0.lock().unwrap() > 0
    }

    fn closed(&self) -> usize {
        let mut count = self.0.lock().unwrap();
        *count = count.saturating_sub(1);
        *count
    }
}

/// The window for a surface, created or brought forward (#223).
#[tauri::command]
pub async fn open_surface(
    app: tauri::AppHandle,
    surface: String,
    soul: Option<String>,
    tab: Option<String>,
    action: Option<String>,
    package: Option<String>,
) -> Result<(), String> {
    let kind = Surface::parse(&surface).ok_or_else(|| format!("unknown surface {surface}"))?;
    if !app.state::<Mode>().single_instance() {
        return Err("a snapshot opens no windows".into());
    }
    if kind.per_soul() && kind != Surface::Audit && soul.as_deref().unwrap_or("").is_empty() {
        return Err(format!("{surface} needs a soul"));
    }
    // Only Launch takes a dropped `.soul` package (#98).
    let package = package.filter(|p| kind == Surface::Launch && !p.is_empty());
    let label = label(kind, soul.as_deref());
    let url = page(
        kind.as_str(),
        &[
            ("soul", soul.as_deref()),
            ("tab", tab.as_deref()),
            ("action", action.as_deref()),
            ("package", package.as_deref()),
        ],
    );
    if let Some(window) = app.get_webview_window(&label) {
        // A launch with a package is a fresh page: the open window loads it.
        if package.is_some() {
            window
                .eval(navigate_script(&url))
                .map_err(|e| e.to_string())?;
        }
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let ((width, height), (min_width, min_height)) = kind.size();
    let tray = *app.state::<Mode>() == Mode::Tray;
    // A window needs the regular policy for keyboard focus and a Dock icon;
    // Windows has no policy to switch, a window simply joins the taskbar.
    #[cfg(target_os = "macos")]
    if tray {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    let documents = app.state::<Documents>();
    documents.opened();
    // Where this window was last, if that is still on a screen (#264);
    // else the design's size, centred.
    let remembered = app
        .state::<Frames>()
        .get(&label)
        .filter(|frame| on_screen(frame, &monitors(&app)));
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("GeniusBar")
        .min_inner_size(min_width, min_height)
        .resizable(true)
        .focused(true);
    let builder = match remembered {
        Some(frame) => builder
            .inner_size(frame.width.max(min_width), frame.height.max(min_height))
            .position(frame.x, frame.y),
        None => builder.inner_size(width, height).center(),
    };
    // The traffic lights float over the page's own header (the design draws
    // the title bar itself); Windows keeps its own frame.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            if documents.closed() == 0 && tray {
                accessory(&app);
            }
            return Err(error.to_string());
        }
    };
    let handle = app.clone();
    let this = window.clone();
    window.on_window_event(move |event| match event {
        // Each move or resize is noted; the file is written as the window
        // closes (and as the app exits), not on every step of a drag.
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(frame) = frame_of(&this) {
                handle.state::<Frames>().record(this.label(), frame);
            }
        }
        WindowEvent::CloseRequested { .. } => save_frames(&handle),
        WindowEvent::Destroyed => {
            save_frames(&handle);
            let left = handle.state::<Documents>().closed();
            if left == 0 && tray && handle.get_webview_window(crate::DESKTOP_LABEL).is_none() {
                accessory(&handle);
            }
        }
        _ => {}
    });
    window.set_focus().map_err(|e| e.to_string())
}

/// Back to a menubar-only app: no Dock icon (nothing to undo on Windows).
fn accessory(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let _ = app;
}

/// One team card the popup wants on the desktop.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TeamSpec {
    pub key: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
}

/// Where a team window without a saved position goes: cascaded from the
/// top-left, under the menu bar, so new teams never stack on one spot.
pub fn cascade(index: usize) -> (f64, f64) {
    let column = (index % 3) as f64;
    let row = (index / 3) as f64;
    (24.0 + column * 320.0, 48.0 + row * 240.0)
}

/// Which `team-*` windows to open and which to close so that exactly
/// `wanted` exist, given the labels open now.
pub fn plan<'a>(open: &[String], wanted: &'a [TeamSpec]) -> (Vec<&'a TeamSpec>, Vec<String>) {
    let labels: HashMap<String, &TeamSpec> = wanted
        .iter()
        .map(|team| (format!("{TEAM_PREFIX}{}", slug(&team.key)), team))
        .collect();
    let create = wanted
        .iter()
        .filter(|team| !open.contains(&format!("{TEAM_PREFIX}{}", slug(&team.key))))
        .collect();
    let close = open
        .iter()
        .filter(|label| label.starts_with(TEAM_PREFIX) && !labels.contains_key(*label))
        .cloned()
        .collect();
    (create, close)
}

/// Makes the desktop hold exactly these team windows (#223). True when the
/// shell does this at all: macOS or Windows (a card sits on the desktop
/// through `always_on_bottom`, ADR-0046 decision 7), tray mode. Elsewhere
/// the page keeps its in-window desktop.
#[tauri::command]
pub async fn sync_team_windows(
    app: tauri::AppHandle,
    teams: Vec<TeamSpec>,
) -> Result<bool, String> {
    if !cfg!(any(target_os = "macos", windows)) || *app.state::<Mode>() != Mode::Tray {
        return Ok(false);
    }
    let open: Vec<String> = app.webview_windows().keys().cloned().collect();
    let (create, close) = plan(&open, &teams);
    let placed = open
        .iter()
        .filter(|label| label.starts_with(TEAM_PREFIX))
        .count();
    log_line(
        &app,
        &format!(
            "sync_team_windows: {} asked, {} open, create {}, close {}",
            teams.len(),
            placed,
            create.len(),
            close.len()
        ),
    );
    for label in close {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
    let mut failed: Vec<String> = Vec::new();
    for (index, team) in create.into_iter().enumerate() {
        let label = format!("{TEAM_PREFIX}{}", slug(&team.key));
        let url = page("team", &[("soul", Some(&team.key))]);
        let (x, y) = match (team.x, team.y) {
            (Some(x), Some(y)) => (x, y),
            _ => cascade(placed + index),
        };
        // A card on the desktop: no frame, no shadow of its own (the card
        // draws one), under every app window, on every Space, never stealing
        // focus when it appears.
        let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title("GeniusBar")
            .inner_size(team.width.max(120.0), team.height.max(48.0))
            .position(x, y)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_bottom(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .accept_first_mouse(true)
            .focused(false);
        // One card that cannot be made (the app still settling right after an
        // update, a window server refusal) never costs the others: it is noted
        // and the popup asks again shortly.
        match builder.build() {
            Ok(window) => {
                let handle = app.clone();
                let gone = label.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Destroyed = event {
                        log_line(&handle, &format!("team window {gone} destroyed"));
                    }
                });
            }
            Err(e) => failed.push(format!("{}: {e}", team.key)),
        }
    }
    // A window already open keeps its size and place: its page fits itself
    // to the card (and to a menu hanging off it) and the person drags it.
    if failed.is_empty() {
        Ok(true)
    } else {
        let message = format!("team windows not created: {}", failed.join("; "));
        log_line(&app, &message);
        Err(message)
    }
}

/// The computer-use perimeter on the real screen (#122): while `on`, a
/// click-through window over the whole primary screen draws the orange
/// border and a small pill at its top names the soul and offers Stop; off
/// closes both. The popup's coordinator calls it as the daemon's
/// `computerUse` set fills and empties. False means this shell keeps the
/// in-popup perimeter (another platform, or the in-window desktop).
#[tauri::command]
pub async fn sync_perimeter(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    // macOS only: the perimeter follows the daemon's computer-use seam,
    // which has no Windows implementation yet.
    if !cfg!(target_os = "macos") || *app.state::<Mode>() != Mode::Tray {
        return Ok(false);
    }
    let open = app.get_webview_window(PERIMETER_LABEL).is_some()
        || app.get_webview_window(HALT_LABEL).is_some();
    if !on {
        for label in [HALT_LABEL, PERIMETER_LABEL] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.close();
            }
        }
        if open {
            log_line(&app, "sync_perimeter: off");
        }
        return Ok(true);
    }
    if open {
        return Ok(true);
    }
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no primary monitor".to_string())?;
    let position = monitor.position();
    let size = monitor.size();
    let ((x, y), (w, h), (px, py)) = perimeter_frame(
        (position.x, position.y),
        (size.width, size.height),
        monitor.scale_factor(),
    );
    log_line(
        &app,
        &format!("sync_perimeter: on, screen {w}x{h} at {x},{y}"),
    );
    // The border: over everything, on every Space, and never in the way of
    // the pointer (the soul is driving it).
    let perimeter = WebviewWindowBuilder::new(
        &app,
        PERIMETER_LABEL,
        WebviewUrl::App(page("perimeter", &[]).into()),
    )
    .title("GeniusBar")
    .position(x, y)
    .inner_size(w, h)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .build()
    .map_err(|e| format!("perimeter window: {e}"))?;
    let _ = perimeter.set_ignore_cursor_events(true);
    // The pill: the one part that takes a click (Stop).
    let halt =
        WebviewWindowBuilder::new(&app, HALT_LABEL, WebviewUrl::App(page("halt", &[]).into()))
            .title("GeniusBar")
            .position(px, py)
            .inner_size(HALT_SIZE.0, HALT_SIZE.1)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .accept_first_mouse(true)
            .focused(false)
            .build();
    if let Err(e) = halt {
        let _ = perimeter.close();
        return Err(format!("halt window: {e}"));
    }
    Ok(true)
}

/// A line from the popup's coordinator for `shell.log` (#223): the shell
/// has no other view of why the page did or did not ask for windows.
#[tauri::command]
pub fn shell_log(app: tauri::AppHandle, message: String) {
    log_line(&app, &format!("ui {message}"));
}

/// Appends one line to `shell.log` in the app's log folder
/// (`~/Library/Logs/app.geniusbar` on macOS): the only trace a tray app
/// launched by LaunchServices leaves. Failures to log are ignored.
pub fn log_line<R: tauri::Runtime>(app: &tauri::AppHandle<R>, message: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("shell.log"))
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{stamp} {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_label_safe_and_distinct() {
        let a = slug("alice/agent_1");
        assert!(a.starts_with("alice_agent_1-"));
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        assert_ne!(slug("a/b"), slug("a.b"));
        assert_eq!(slug("a/b"), slug("a/b"));
    }

    #[test]
    fn labels_follow_the_surface() {
        assert_eq!(label(Surface::Launch, Some("x/y")), "launch");
        assert_eq!(label(Surface::Audit, None), "audit");
        assert!(label(Surface::Audit, Some("x/y")).starts_with("audit-x_y-"));
        assert!(label(Surface::Session, Some("x/y")).starts_with("session-x_y-"));
        assert!(label(Surface::Customize, Some("x/y")).starts_with("customize-x_y-"));
    }

    #[test]
    fn pages_carry_the_query() {
        assert_eq!(
            page("launch", &[("soul", None)]),
            "index.html?surface=launch"
        );
        assert_eq!(
            page(
                "session",
                &[
                    ("soul", Some("acct/agent id")),
                    ("tab", Some("audit")),
                    ("action", Some(""))
                ]
            ),
            "index.html?surface=session&soul=acct%2Fagent%20id&tab=audit"
        );
    }

    #[test]
    fn launch_pages_carry_a_package_safely() {
        let params = [
            ("soul", None),
            ("package", Some("/Users/me/It's mine.soul/")),
        ];
        let url = page("launch", &params);
        assert_eq!(
            url,
            "index.html?surface=launch&package=%2FUsers%2Fme%2FIt%27s%20mine.soul%2F"
        );
        assert_eq!(
            navigate_script(&url),
            "window.location.replace('index.html?surface=launch&package=%2FUsers%2Fme%2FIt%27s%20mine.soul%2F')"
        );
        assert!(!url.contains('\''));
    }

    #[test]
    fn plans_create_and_close_only_team_windows() {
        let team = |key: &str| TeamSpec {
            key: key.into(),
            x: None,
            y: None,
            width: 300.0,
            height: 200.0,
        };
        let wanted = [team("a/1"), team("a/2")];
        let open = vec![
            "main".to_string(),
            format!("team-{}", slug("a/1")),
            format!("team-{}", slug("a/9")),
            "session-x".into(),
        ];
        let (create, close) = plan(&open, &wanted);
        assert_eq!(
            create.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(),
            ["a/2"]
        );
        assert_eq!(close, [format!("team-{}", slug("a/9"))]);
    }

    #[test]
    fn perimeter_covers_the_screen_and_centres_the_pill() {
        let ((x, y), (w, h), (px, py)) = perimeter_frame((0, 0), (2880, 1800), 2.0);
        assert_eq!((x, y), (0.0, 0.0));
        assert_eq!((w, h), (1440.0, 900.0));
        assert_eq!((px, py), (480.0, 6.0));
        // A second monitor to the right, at 1x: offsets carry through.
        let ((x, _), _, (px, py)) = perimeter_frame((1440, -100), (1000, 600), 1.0);
        assert_eq!(x, 1440.0);
        assert_eq!((px, py), (1700.0, -94.0));
        // A bad scale never divides by zero.
        let (_, (w, _), _) = perimeter_frame((0, 0), (800, 600), 0.0);
        assert_eq!(w, 800.0);
    }

    #[test]
    fn cascade_never_stacks() {
        let spots: Vec<_> = (0..6).map(cascade).collect();
        for (i, a) in spots.iter().enumerate() {
            for b in &spots[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(cascade(0), (24.0, 48.0));
    }

    #[test]
    fn surfaces_parse() {
        assert_eq!(Surface::parse("session"), Some(Surface::Session));
        assert_eq!(Surface::parse("tray"), None);
        assert!(Surface::Launch.size().0 .0 > Surface::Launch.size().1 .0);
    }

    #[test]
    fn frames_round_trip_and_drop_the_malformed() {
        let frames = Frames::default();
        let session = Frame {
            x: 100.0,
            y: 80.5,
            width: 820.0,
            height: 700.0,
        };
        frames.record("session-abc", session);
        frames.record(
            "main",
            Frame {
                x: 0.0,
                y: 0.0,
                width: 420.0,
                height: 640.0,
            },
        );
        // Nothing to show is not remembered.
        frames.record(
            "audit",
            Frame {
                x: 1.0,
                y: 1.0,
                width: 0.0,
                height: 300.0,
            },
        );
        frames.record(
            "launch",
            Frame {
                x: f64::NAN,
                y: 1.0,
                width: 300.0,
                height: 300.0,
            },
        );
        let text = Frames::to_text(&frames.0.lock().unwrap());
        let back = Frames::parse(&text);
        assert_eq!(back.len(), 2);
        assert_eq!(back["session-abc"], session);
        assert_eq!(back["main"].width, 420.0);
        // A frame with nothing to show is dropped; the rest of the file stays.
        let partial = Frames::parse(
            r#"{"audit":{"x":10,"y":20,"width":600,"height":400},"zero":{"x":0,"y":0,"width":-1,"height":5}}"#,
        );
        assert_eq!(partial.len(), 1);
        assert_eq!(partial["audit"].height, 400.0);
        // A file that is not frames at all is no frames.
        assert!(Frames::parse(r#"{"bad":{"x":"left"}}"#).is_empty());
        assert!(Frames::parse("not json").is_empty());
        assert!(Frames::parse("").is_empty());
    }

    #[test]
    fn frames_save_and_load_through_a_file() {
        let dir = std::env::temp_dir().join(format!("gb-frames-{}", std::process::id()));
        let path = dir.join("nested").join("windows.json");
        let frames = Frames::default();
        frames.record(
            "session-x",
            Frame {
                x: 5.0,
                y: 6.0,
                width: 700.0,
                height: 500.0,
            },
        );
        frames.save_to(&path).unwrap();
        let again = Frames::default();
        again.load_from(&path);
        assert_eq!(again.get("session-x").unwrap().width, 700.0);
        assert_eq!(again.get("session-y"), None);
        // A missing file leaves what is held.
        again.load_from(&dir.join("missing.json"));
        assert!(again.get("session-x").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_frame_is_restored_only_on_a_screen_still_here() {
        let main = ((0.0, 0.0), (1440.0, 900.0));
        let right = ((1440.0, -100.0), (1920.0, 1080.0));
        let frame = |x, y| Frame {
            x,
            y,
            width: 780.0,
            height: 660.0,
        };
        assert!(on_screen(&frame(100.0, 100.0), &[main]));
        assert!(on_screen(&frame(1500.0, -50.0), &[main, right]));
        // The monitor to the right was unplugged.
        assert!(!on_screen(&frame(1500.0, -50.0), &[main]));
        // Just off the bottom-right, or on no monitor at all.
        assert!(!on_screen(&frame(1420.0, 890.0), &[main]));
        assert!(!on_screen(&frame(100.0, 100.0), &[]));
    }

    #[test]
    fn documents_count_down_to_zero() {
        let documents = Documents::default();
        assert_eq!(documents.opened(), 1);
        assert_eq!(documents.opened(), 2);
        assert_eq!(documents.closed(), 1);
        assert_eq!(documents.closed(), 0);
        assert_eq!(documents.closed(), 0);
    }
}
