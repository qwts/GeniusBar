//! The starter soul (R4): the package GeniusBar ships so a first launch
//! needs nothing but a click. The web view learns where it is, which
//! account to launch it in, and which harnesses it prefers.

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Serialize, PartialEq)]
pub struct Starter {
    /// The package directory inside the app bundle.
    pub package: String,
    /// This macOS user, which is the agent-comms account setup paired.
    pub account: String,
    pub name: String,
    /// The soul's own order of preference, first is the default.
    pub harnesses: Vec<String>,
}

pub fn read_starter(package: &Path, account: &str) -> Result<Starter, String> {
    let text = std::fs::read_to_string(package.join("soul.json")).map_err(|e| e.to_string())?;
    let manifest: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let name = manifest["name"].as_str().unwrap_or("Starter").to_owned();
    let harnesses = manifest["preferredHarnesses"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|h| h.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if account.is_empty() {
        return Err("the macOS user name is unknown".into());
    }
    Ok(Starter {
        package: package.to_string_lossy().into_owned(),
        account: account.to_owned(),
        name,
        harnesses,
    })
}

#[tauri::command]
pub fn starter_soul<R: Runtime>(app: AppHandle<R>) -> Result<Starter, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let account = std::env::var("USER").unwrap_or_default();
    read_starter(&resources.join("souls").join("starter.soul"), &account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shipped_starter_soul() {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../souls/starter.soul");
        let starter = read_starter(&package, "friend").unwrap();
        assert_eq!(starter.account, "friend");
        assert_eq!(starter.name, "Starter");
        assert_eq!(
            starter.harnesses.first().map(String::as_str),
            Some("claude")
        );
    }

    #[test]
    fn refuses_an_unknown_user() {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../souls/starter.soul");
        assert!(read_starter(&package, "").is_err());
    }
}
