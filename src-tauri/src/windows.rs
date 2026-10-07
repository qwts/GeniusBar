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
use std::sync::Mutex;

use serde::Deserialize;
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
    // A window needs the regular policy for keyboard focus and a Dock icon.
    #[cfg(target_os = "macos")]
    if tray {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    let documents = app.state::<Documents>();
    documents.opened();
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("GeniusBar")
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .resizable(true)
        .center()
        .focused(true);
    // The traffic lights float over the page's own header (the design draws
    // the title bar itself).
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
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let left = handle.state::<Documents>().closed();
            if left == 0 && tray && handle.get_webview_window(crate::DESKTOP_LABEL).is_none() {
                accessory(&handle);
            }
        }
    });
    window.set_focus().map_err(|e| e.to_string())
}

/// Back to a menubar-only app: no Dock icon.
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
/// shell does this at all: macOS, tray mode. Elsewhere the page keeps its
/// in-window desktop.
#[tauri::command]
pub async fn sync_team_windows(
    app: tauri::AppHandle,
    teams: Vec<TeamSpec>,
) -> Result<bool, String> {
    if !cfg!(target_os = "macos") || *app.state::<Mode>() != Mode::Tray {
        return Ok(false);
    }
    let open: Vec<String> = app.webview_windows().keys().cloned().collect();
    let (create, close) = plan(&open, &teams);
    for label in close {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
    let placed = open
        .iter()
        .filter(|label| label.starts_with(TEAM_PREFIX))
        .count();
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
        builder.build().map_err(|e| e.to_string())?;
    }
    // A window already open keeps its size and place: its page fits itself
    // to the card (and to a menu hanging off it) and the person drags it.
    Ok(true)
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
    fn documents_count_down_to_zero() {
        let documents = Documents::default();
        assert_eq!(documents.opened(), 1);
        assert_eq!(documents.opened(), 2);
        assert_eq!(documents.closed(), 1);
        assert_eq!(documents.closed(), 0);
        assert_eq!(documents.closed(), 0);
    }
}
