//! `--snapshot PATH [--snapshot-detail AGENT_ID]` (#6): renders the popup
//! to a PNG and exits, as R1 did, for automation and CI that cannot see a
//! menubar. The popup loads hidden and fetches its census through the
//! bridge exactly as it does when shown (so custody and auth are
//! exercised), reports once that census settled, and the shell captures
//! its web view at scale 2. Stdout gets `{"snapshot":"<path>","souls":N}`
//! even on failure; the error goes to stderr and the exit code is 1.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

/// What `--snapshot` asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub path: PathBuf,
    /// `--snapshot-detail`: the soul whose detail opens beneath the list.
    pub detail: Option<String>,
}

/// How long the popup may take to report its first settled census. The
/// bridge gives up on a census after 15 seconds, so this outlasts it.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long WebKit may take to hand back the image once asked.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// The launch's snapshot request, if any, and its progress.
#[derive(Default)]
pub struct Snapshot {
    request: Option<Request>,
    captured: AtomicBool,
    finished: AtomicBool,
}

impl Snapshot {
    pub fn new(request: Option<Request>) -> Self {
        Self {
            request,
            ..Self::default()
        }
    }
}

/// What the popup needs to know to render a snapshot.
#[derive(Debug, Serialize, PartialEq)]
pub struct Options {
    detail: Option<String>,
}

/// Null for a normal launch; otherwise the popup renders statically and
/// calls `snapshot_ready` once its census settled.
#[tauri::command]
pub fn snapshot_options(state: State<'_, Snapshot>) -> Option<Options> {
    state.request.as_ref().map(|request| Options {
        detail: request.detail.clone(),
    })
}

/// The popup's census settled and rendered: capture it. `error` is the
/// failure the popup shows (unpaired, unreachable, unknown detail ID).
#[tauri::command]
pub fn snapshot_ready<R: Runtime>(window: WebviewWindow<R>, souls: u64, error: Option<String>) {
    capture(&window, souls, error);
}

/// Captures whatever the popup shows if it never reports, and exits if
/// the capture itself never completes.
pub fn start<R: Runtime>(window: WebviewWindow<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE_TIMEOUT).await;
        capture(
            &window,
            0,
            Some("timed out waiting for the census to settle".into()),
        );
        tokio::time::sleep(CAPTURE_TIMEOUT).await;
        let app = window.app_handle();
        if let Some(request) = app.state::<Snapshot>().request.clone() {
            finish(
                app,
                &request,
                0,
                None,
                Err("the web view produced no image".into()),
            );
        }
    });
}

fn capture<R: Runtime>(window: &WebviewWindow<R>, souls: u64, error: Option<String>) {
    let state = window.state::<Snapshot>();
    let Some(request) = state.request.clone() else {
        return;
    };
    if state.captured.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = window.app_handle().clone();
    let finishing = (app.clone(), request.clone(), error.clone());
    let started = window.with_webview(move |webview| {
        platform::snapshot(webview, move |png| {
            finish(&app, &request, souls, error, png);
        });
    });
    if let Err(e) = started {
        let (app, request, error) = finishing;
        finish(&app, &request, souls, error, Err(e.to_string()));
    }
}

/// Writes the PNG, prints the JSON line and any error, and exits. Runs
/// once, whichever of the capture and the watchdog gets here first.
fn finish<R: Runtime>(
    app: &AppHandle<R>,
    request: &Request,
    souls: u64,
    error: Option<String>,
    png: Result<Vec<u8>, String>,
) {
    if app
        .state::<Snapshot>()
        .finished
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let written = png.and_then(|png| {
        write_png(&request.path, &png)
            .map_err(|e| format!("cannot write {}: {e}", request.path.display()))
    });
    let failures: Vec<String> = error.into_iter().chain(written.err()).collect();
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{}", report_line(&request.path, souls));
    let _ = stdout.flush();
    for failure in &failures {
        eprintln!("snapshot: {failure}");
    }
    app.exit(if failures.is_empty() { 0 } else { 1 });
}

/// The one stdout line automation reads to find the rendering.
pub fn report_line(path: &Path, souls: u64) -> String {
    json!({ "snapshot": path.to_string_lossy(), "souls": souls }).to_string()
}

/// Writes atomically, creating the parent directory as R1 did.
fn write_png(path: &Path, png: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    std::fs::write(&partial, png)?;
    std::fs::rename(&partial, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&partial);
    })
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::Cell;

    use block2::RcBlock;
    use objc2::{rc::Retained, AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    /// R1 rendered at scale 2 whatever the screen, so the PNG's size does
    /// not depend on the machine that took it.
    const SCALE: f64 = 2.0;

    /// Asks WebKit for an image of the web view's bounds; `done` runs on
    /// the main thread with the PNG bytes.
    pub fn snapshot(
        webview: tauri::webview::PlatformWebview,
        done: impl FnOnce(Result<Vec<u8>, String>) + 'static,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            return done(Err("the web view is not on the main thread".into()));
        };
        // SAFETY: on macOS, Tauri's platform web view is its WKWebView,
        // alive for the duration of this main-thread callback.
        let view: Retained<WKWebView> =
            match unsafe { Retained::retain(webview.inner().cast::<WKWebView>()) } {
                Some(view) => view,
                None => return done(Err("the window has no web view".into())),
            };
        let done = Cell::new(Some(done));
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let Some(done) = done.take() else {
                return;
            };
            // SAFETY: WebKit passes a valid image or a valid error.
            let result = match unsafe { image.as_ref() } {
                Some(image) => png_at_scale(image),
                None => Err(unsafe { error.as_ref() }.map_or_else(
                    || "the web view produced no image".to_string(),
                    |e| e.localizedDescription().to_string(),
                )),
            };
            done(result);
        });
        // SAFETY: called on the main thread with a live web view; WebKit
        // copies the handler block.
        unsafe {
            let config = WKSnapshotConfiguration::new(mtm);
            config.setAfterScreenUpdates(true);
            view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        }
    }

    /// Draws the image into a bitmap of exactly SCALE pixels per point.
    fn png_at_scale(image: &NSImage) -> Result<Vec<u8>, String> {
        let size = image.size();
        let wide = (size.width * SCALE).round() as isize;
        let high = (size.height * SCALE).round() as isize;
        if wide <= 0 || high <= 0 {
            return Err("the web view produced an empty image".into());
        }
        // SAFETY: a null plane pointer makes AppKit allocate the buffer.
        let bitmap = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                wide,
                high,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }
        .ok_or("cannot allocate the bitmap")?;
        bitmap.setSize(size);
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)
            .ok_or("cannot draw into the bitmap")?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));
        image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), size));
        context.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        // SAFETY: an empty property dictionary is valid for PNG.
        let png = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }
        .ok_or("cannot encode the PNG")?;
        Ok(png.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn snapshot(
        _webview: tauri::webview::PlatformWebview,
        done: impl FnOnce(Result<Vec<u8>, String>) + 'static,
    ) {
        done(Err("snapshots need macOS".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_line_is_one_json_object() {
        assert_eq!(
            report_line(Path::new("/tmp/a \"b\".png"), 3),
            r#"{"snapshot":"/tmp/a \"b\".png","souls":3}"#
        );
    }

    #[test]
    fn writes_the_png_into_a_new_directory() {
        let dir = std::env::temp_dir().join(format!("geniusbar-snapshot-{}", std::process::id()));
        let path = dir.join("nested").join("snap.png");
        write_png(&path, b"png").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"png");
        assert!(!dir.join("nested").join("snap.png.partial").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
