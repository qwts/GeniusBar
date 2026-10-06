//! The tray item's approval badge (#85): how many tool calls wait on the
//! owner, shown beside the G as the Lovable design badges it. The icon is a
//! macOS template image, which the system tints and cannot carry a coloured
//! badge, so the count is the item's title; at 0 the title is cleared and
//! the item is the plain G again.

use tauri::{AppHandle, Runtime};

/// The tray item's id, as `install_tray` builds it.
pub const TRAY_ID: &str = "geniusbar";

/// The title beside the icon: nothing at 0, capped at 99+.
pub fn badge_title(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=99 => Some(count.to_string()),
        _ => Some("99+".to_string()),
    }
}

/// The web view reports the pending count; other modes have no tray.
#[tauri::command]
pub fn set_tray_badge<R: Runtime>(app: AppHandle<R>, count: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_title(badge_title(count))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_title_at_zero() {
        assert_eq!(badge_title(0), None);
    }

    #[test]
    fn counts_and_caps() {
        assert_eq!(badge_title(1).as_deref(), Some("1"));
        assert_eq!(badge_title(99).as_deref(), Some("99"));
        assert_eq!(badge_title(100).as_deref(), Some("99+"));
    }
}
