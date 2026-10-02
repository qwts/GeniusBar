//! Snapshot mode (#6, R1's `--snapshot PATH [--snapshot-detail ID]`): the
//! web view renders the popup once and sends a PNG of it here; the shell
//! writes the file, prints `{"snapshot":PATH,"souls":N}`, and exits 0, or 1
//! with the error on stderr. The window is never shown.

use std::{path::PathBuf, thread, time::Duration};

use serde_json::{json, Value};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Runtime, State,
};

/// The snapshot this launch should take, if any.
#[derive(Debug, Default)]
pub struct SnapshotRequest(pub Option<(PathBuf, Option<String>)>);

/// A web view that never delivers still ends the process.
const DEADLINE: Duration = Duration::from_secs(30);

/// Exits with an error if no snapshot arrives in time.
pub fn arm_deadline<R: Runtime>(app: AppHandle<R>) {
    thread::spawn(move || {
        thread::sleep(DEADLINE);
        eprintln!(
            "snapshot: the page was not rendered within {}s",
            DEADLINE.as_secs()
        );
        app.exit(1);
    });
}

#[tauri::command]
pub fn snapshot_options(state: State<'_, SnapshotRequest>) -> Option<Value> {
    state
        .0
        .as_ref()
        .map(|(_, detail)| json!({ "detail": detail }))
}

/// Decodes `encodeURIComponent` output; invalid escapes are kept as is.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
pub fn snapshot_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SnapshotRequest>,
    request: Request<'_>,
) -> Result<(), String> {
    let Some((path, _)) = state.0.as_ref() else {
        return Err("not in snapshot mode".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let souls: u64 = header("x-souls").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut error = header("x-error").map(percent_decode);
    match request.body() {
        InvokeBody::Raw(png) if !png.is_empty() => {
            if let Err(e) = std::fs::write(path, png) {
                error.get_or_insert(format!("could not write {}: {e}", path.display()));
            }
        }
        _ => {
            error.get_or_insert_with(|| "the page sent no PNG".into());
        }
    }
    println!("{}", json!({ "snapshot": path, "souls": souls }));
    if let Some(error) = &error {
        eprintln!("snapshot: {error}");
    }
    app.exit(i32::from(error.is_some()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_uri_components() {
        assert_eq!(
            percent_decode("unknown%20detail%20ID%20agent_x"),
            "unknown detail ID agent_x"
        );
        assert_eq!(percent_decode("caf%C3%A9%3A%20down"), "café: down");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
