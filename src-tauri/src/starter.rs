//! The starter soul (R4), Genius since #287 (the package keeps its
//! `starter.soul` folder and identifiers): the package GeniusBar ships so a
//! first launch needs nothing but a click. The web view learns where it is, which
//! account to launch it in, and which harnesses it prefers. It also learns
//! whether Apple's command line tools are installed: soul homes are git
//! worktrees and Claude Code runs git, and a stock Mac's /usr/bin/git is
//! only a stub that asks to install them.

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
    /// Whether git works, from Apple's command line tools or Xcode.
    #[serde(rename = "devTools")]
    pub dev_tools: bool,
    /// Whether Apple's installer for them is open now, so the web view can
    /// tell a running install from a cancelled one (#101).
    #[serde(rename = "devToolsInstalling")]
    pub dev_tools_installing: bool,
}

/// Metadata read from the soul manifest. Launching a package uses the same
/// manifest reader as the bundled Genius, so an opened package is checked
/// by the format GeniusBar already accepts.
#[derive(Debug, PartialEq)]
pub struct SoulPackage {
    pub name: String,
    pub harnesses: Vec<String>,
}

pub fn read_soul_package(package: &Path) -> Result<SoulPackage, String> {
    let text = std::fs::read_to_string(package.join("soul.json")).map_err(|e| e.to_string())?;
    let manifest: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let name = manifest["name"].as_str().unwrap_or("Genius").to_owned();
    let harnesses = manifest["preferredHarnesses"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|h| h.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(SoulPackage { name, harnesses })
}

pub fn read_starter(package: &Path, account: &str, dev_tools: bool) -> Result<Starter, String> {
    let metadata = read_soul_package(package)?;
    if account.is_empty() {
        return Err("the macOS user name is unknown".into());
    }
    Ok(Starter {
        package: package.to_string_lossy().into_owned(),
        account: account.to_owned(),
        name: metadata.name,
        harnesses: metadata.harnesses,
        dev_tools,
        dev_tools_installing: false,
    })
}

/// Whether git works: the bundled git (#102), which the souls' PATH names
/// first, or Apple's command line tools (`xcode-select -p` names a developer
/// directory only once they or Xcode are installed). Elsewhere git is the
/// user's own concern.
fn dev_tools_installed(resources: &Path) -> bool {
    // Windows has no Apple tools: the bundled MinGit is the whole answer
    // (ADR-0046 decision 6).
    if cfg!(windows) {
        return bundled_git_works(resources);
    }
    if !cfg!(target_os = "macos") {
        return true;
    }
    bundled_git_works(resources)
        || std::process::Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

/// `bin/git --version` through the shim the souls get: the sidecar and the
/// helper path it names must both be there. A development build without
/// them (no `build-git.mjs` run) falls back to the command line tools.
pub fn bundled_git_works(resources: &Path) -> bool {
    // `bin\git.cmd` only forwards to MinGit's `git\cmd\git.exe`, and a
    // `.cmd` cannot be started without `cmd`, so Windows asks git itself.
    let git = if cfg!(windows) {
        resources.join("git").join("cmd").join("git.exe")
    } else {
        resources.join("bin").join("git")
    };
    std::process::Command::new(git)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// `xcode-select --install` opens this app; it stays open while the tools
/// download and install, and closes when the owner cancels.
const DEV_TOOLS_INSTALLER: &str = "Install Command Line Developer Tools.app";

fn dev_tools_installer_open() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    std::process::Command::new("/usr/bin/pgrep")
        .args(["-f", DEV_TOOLS_INSTALLER])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[tauri::command]
pub fn starter_soul<R: Runtime>(app: AppHandle<R>) -> Result<Starter, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    // Windows names the account in USERNAME.
    let account =
        std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default();
    let dev_tools = dev_tools_installed(&resources);
    let mut starter = read_starter(
        &resources.join("souls").join("starter.soul"),
        &account,
        dev_tools,
    )?;
    starter.dev_tools_installing = !dev_tools && dev_tools_installer_open();
    Ok(starter)
}

/// Opens Apple's own installer for the command line tools. It runs on its
/// own; the web view polls `starter_soul` until the tools are there or the
/// installer has closed.
#[cfg(not(windows))]
#[tauri::command]
pub fn install_dev_tools() -> Result<(), String> {
    std::process::Command::new("/usr/bin/xcode-select")
        .arg("--install")
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

/// Windows has nothing to install: git ships inside the bundle (ADR-0046
/// decision 6), so a build without it is a packaging fault, which the
/// message says (the web view shows it beside Retry).
#[cfg(windows)]
#[tauri::command]
pub fn install_dev_tools() -> Result<(), String> {
    Err(
        "this GeniusBar build is missing its bundled git (resources\\git); reinstall GeniusBar"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shipped_starter_soul() {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../souls/starter.soul");
        let starter = read_starter(&package, "friend", false).unwrap();
        assert_eq!(starter.account, "friend");
        assert_eq!(starter.name, "Genius");
        assert!(!starter.dev_tools);
        assert!(!starter.dev_tools_installing);
        assert_eq!(
            starter.harnesses.first().map(String::as_str),
            Some("claude")
        );
    }

    #[test]
    fn bundled_git_is_absent_without_the_sidecar() {
        let resources =
            std::env::temp_dir().join(format!("geniusbar-no-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&resources);
        std::fs::create_dir_all(resources.join("bin")).unwrap();
        assert!(!bundled_git_works(&resources));
        // The shim is there but the sidecar it execs is not.
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../bin/git"),
            resources.join("bin").join("git"),
        )
        .unwrap();
        assert!(!bundled_git_works(&resources));
        std::fs::remove_dir_all(resources).unwrap();
    }

    #[test]
    fn refuses_an_unknown_user() {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../souls/starter.soul");
        assert!(read_starter(&package, "", true).is_err());
    }

    #[test]
    fn reads_an_opened_package_with_the_starter_manifest_reader() {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../souls/starter.soul");
        assert_eq!(
            read_soul_package(&package).unwrap(),
            SoulPackage {
                name: "Genius".into(),
                harnesses: vec!["claude".into(), "codex".into()]
            }
        );
    }

    #[test]
    fn reports_a_missing_or_unreadable_soul_manifest() {
        let package =
            std::env::temp_dir().join(format!("geniusbar-missing-soul-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&package);
        std::fs::create_dir(&package).unwrap();
        assert!(read_soul_package(&package).is_err());
        std::fs::write(package.join("soul.json"), "not json").unwrap();
        assert!(read_soul_package(&package).is_err());
        std::fs::remove_dir_all(package).unwrap();
    }
}
