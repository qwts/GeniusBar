//! File-open routing for `.soul` packages. macOS delivers documents through
//! `RunEvent::Opened`; paths are queued until the web view has mounted.

use std::{path::PathBuf, sync::Mutex};

use tauri::{State, Url};

#[derive(Default)]
pub struct PendingSoulPackages(Mutex<Vec<PathBuf>>);

/// Return a local `.soul` document path. Other files and non-file URLs are
/// ignored so unrelated open events never enter the Launch package flow.
pub fn soul_path_from_url(url: &Url) -> Option<PathBuf> {
    let path = url.to_file_path().ok()?;
    let extension = path.extension()?.to_str()?;
    extension.eq_ignore_ascii_case("soul").then_some(path)
}

impl PendingSoulPackages {
    pub fn enqueue_urls(&self, urls: &[Url]) -> Vec<PathBuf> {
        let paths = urls
            .iter()
            .filter_map(soul_path_from_url)
            .collect::<Vec<_>>();
        if !paths.is_empty() {
            self.0
                .lock()
                .expect("pending package lock")
                .extend(paths.iter().cloned());
        }
        paths
    }

    fn take(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.0.lock().expect("pending package lock"))
    }
}

#[tauri::command]
pub fn take_opened_soul_packages(pending: State<'_, PendingSoulPackages>) -> Vec<String> {
    pending
        .take()
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub fn validate_soul_package(package: String) -> Result<(), String> {
    crate::starter::read_soul_package(&PathBuf::from(package)).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn routes_only_local_soul_documents() {
        assert_eq!(
            soul_path_from_url(&url("file:///Users/friend/Downloads/My%20Soul.soul")),
            Some(PathBuf::from("/Users/friend/Downloads/My Soul.soul")),
        );
        assert_eq!(
            soul_path_from_url(&url("file:///Users/friend/notes.txt")),
            None
        );
        assert_eq!(
            soul_path_from_url(&url("https://example.com/my-soul.soul")),
            None
        );
    }

    #[test]
    fn queues_opened_packages_once_and_drains_them_for_the_ui() {
        let pending = PendingSoulPackages::default();
        let paths = pending.enqueue_urls(&[
            url("file:///Users/friend/one.soul"),
            url("file:///Users/friend/readme.txt"),
            url("file:///Users/friend/two.soul"),
        ]);
        assert_eq!(paths.len(), 2);
        assert_eq!(pending.take(), paths);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn declares_soul_folders_as_a_package_type() {
        // A .soul is a directory. Finder shows it as one shareable item only
        // when its exported type conforms to com.apple.package.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let association = &conf["bundle"]["fileAssociations"][0];
        assert_eq!(association["ext"][0], "soul");
        let conforms = association["exportedType"]["conformsTo"]
            .as_array()
            .unwrap();
        assert!(conforms.iter().any(|t| t == "com.apple.package"));
        assert!(!conforms.iter().any(|t| t == "public.data"));
    }
}
