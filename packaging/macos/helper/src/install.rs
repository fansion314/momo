use crate::{HELPER_PATH, Installation, LABEL, PLIST_PATH, ROOT, SOCKET, SOCKET_DIR, files};
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    cmd
}

pub fn run_bounded(cmd: Command, timeout: Duration, max_output: u64) -> Result<Vec<u8>> {
    run_cancelled(
        cmd,
        timeout,
        max_output,
        &std::sync::atomic::AtomicBool::new(false),
    )
}

pub fn run_cancelled(
    mut cmd: Command,
    timeout: Duration,
    max_output: u64,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<u8>> {
    let mut output = tempfile::tempfile()?;
    cmd.stdout(output.try_clone()?).stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("operation cancelled");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("command timed out");
        }
        if output.metadata()?.len() > max_output {
            let _ = child.kill();
            let _ = child.wait();
            bail!("command output exceeds limit");
        }
        thread::sleep(Duration::from_millis(20));
    };
    ensure!(status.success(), "command failed");
    ensure!(
        output.metadata()?.len() <= max_output,
        "command output exceeds limit"
    );
    use std::io::{Seek, SeekFrom};
    output.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    output.take(max_output + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn run_quiet(
    mut cmd: Command,
    timeout: Duration,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "command failed");
            return Ok(());
        }
        if cancelled.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("command cancelled or timed out");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn launchctl(args: &[&str]) -> Result<()> {
    let mut cmd = command("/bin/launchctl");
    cmd.args(args);
    run_bounded(cmd, Duration::from_secs(35), 16384)?;
    Ok(())
}

pub fn capabilities(core: &Path) -> Result<String> {
    #[derive(Deserialize)]
    struct Capabilities {
        protocol: u32,
        version: String,
        #[serde(rename = "managedMode")]
        managed: bool,
    }
    let mut cmd = command(core);
    cmd.arg("--momo-capabilities").env("HOME", ROOT);
    let cap: Capabilities =
        serde_json::from_slice(&run_bounded(cmd, Duration::from_secs(10), 16384)?)?;
    ensure!(
        cap.protocol == 1 && cap.managed && !cap.version.is_empty(),
        "core does not support managed protocol 1"
    );
    Ok(cap.version)
}

pub fn remove_legacy_socket(root: &Path, uid: u32) -> Result<()> {
    let dir = root.join("run");
    if !dir.try_exists()? {
        return Ok(());
    }
    files::protected_ancestors(&dir)?;
    let socket = dir.join("helper.sock");
    let info = match fs::symlink_metadata(&socket) {
        Ok(info) => info,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    ensure!(
        info.file_type().is_socket() && (info.uid() == 0 || info.uid() == uid),
        "unexpected legacy helper socket"
    );
    fs::remove_file(socket)?;
    Ok(())
}

pub fn remove_socket(uid: Option<u32>) -> Result<()> {
    let dir = Path::new(SOCKET_DIR);
    if !dir.try_exists()? {
        return Ok(());
    }
    files::protected_ancestors(dir)?;
    let info = match fs::symlink_metadata(SOCKET) {
        Ok(info) => info,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    ensure!(
        info.file_type().is_socket() && (info.uid() == 0 || uid == Some(info.uid())),
        "unexpected helper socket"
    );
    fs::remove_file(SOCKET)?;
    Ok(())
}

fn install_lock() -> Result<File> {
    let path = Path::new("/Library/PrivilegedHelperTools/world.fansionia.clash-momo.install.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    files::protected_info(path, &file.metadata()?)?;
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "another installation is active"
    );
    Ok(file)
}

pub fn install(uid: u32, core: &Path) -> Result<()> {
    ensure!(
        uid > 0 && core.is_absolute(),
        "install requires positive UID and absolute approved core path"
    );
    for parent in [
        "/Library/Application Support",
        "/Library/PrivilegedHelperTools",
        "/Library/LaunchDaemons",
    ] {
        let path = Path::new(parent);
        if !path.try_exists()? {
            fs::create_dir(path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        }
        files::protected_ancestors(path)?;
    }
    let _lock = install_lock()?;
    let stage = tempfile::Builder::new()
        .prefix(".world.fansionia.clash-momo.install-")
        .tempdir_in("/Library/Application Support")?;
    files::copy_executable(&std::env::current_exe()?, &stage.path().join("helper"))?;
    files::copy_executable(core, &stage.path().join("core"))?;
    let installation = Installation {
        uid,
        core_version: capabilities(&stage.path().join("core"))?,
        helper_hash: files::file_hash(&stage.path().join("helper"))?,
        core_hash: files::file_hash(&stage.path().join("core"))?,
    };
    files::write_json(&stage.path().join("installation.json"), &installation)?;
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>{LABEL}</string>
<key>ProgramArguments</key><array><string>{HELPER_PATH}</string><string>serve</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ExitTimeOut</key><integer>25</integer>
<key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string></dict></plist>"#
    );
    files::atomic_write(&stage.path().join("daemon.plist"), plist.as_bytes(), 0o644)?;
    let service = format!("system/{LABEL}");
    let loaded = launchctl(&["print", &service]).is_ok();
    if loaded {
        launchctl(&["bootout", &service])?;
    }
    let mut changes: Vec<(PathBuf, PathBuf, bool)> = Vec::new();
    let result = (|| -> Result<()> {
        let old_uid = files::read_json::<Installation>(&Path::new(ROOT).join("installation.json"))
            .ok()
            .map(|i| i.uid);
        remove_socket(old_uid.or(Some(uid)))?;
        remove_legacy_socket(Path::new(ROOT), uid)?;
        files::mkdir_protected(Path::new(ROOT))?;
        files::mkdir_protected(&Path::new(ROOT).join("data"))?;
        files::protected_tree(Path::new(ROOT))?;
        for (n, (source, target)) in [
            ("helper", PathBuf::from(HELPER_PATH)),
            ("core", Path::new(ROOT).join("mihomomo")),
            (
                "installation.json",
                Path::new(ROOT).join("installation.json"),
            ),
            ("daemon.plist", PathBuf::from(PLIST_PATH)),
        ]
        .into_iter()
        .enumerate()
        {
            let backup = stage.path().join(format!("old-{n}"));
            let exists = match fs::symlink_metadata(&target) {
                Ok(info) => {
                    files::protected_info(&target, &info)?;
                    ensure!(info.is_file(), "unexpected installed file");
                    fs::rename(&target, &backup)?;
                    true
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(e) => return Err(e.into()),
            };
            changes.push((target.clone(), backup, exists));
            if source == "helper" || source == "core" {
                files::copy_executable(&stage.path().join(source), &target)?;
                if source == "helper" {
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;
                }
            } else {
                files::atomic_write(
                    &target,
                    &fs::read(stage.path().join(source))?,
                    if source == "daemon.plist" {
                        0o644
                    } else {
                        0o600
                    },
                )?;
            }
        }
        launchctl(&["enable", &service])?;
        launchctl(&["bootstrap", "system", PLIST_PATH])?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let mut cmd = command(HELPER_PATH);
            // Readiness must exercise the installed socket as the bound user.
            cmd.arg("status").uid(uid).gid(uid);
            let valid = run_bounded(cmd, Duration::from_secs(2), 16384)
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .is_some_and(|s| {
                    s["protocol"] == 1
                        && s["uid"] == uid
                        && s["helperHash"] == installation.helper_hash
                        && s["coreHash"] == installation.core_hash
                });
            if valid {
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "installed helper did not pass its readiness probe"
            );
            thread::sleep(Duration::from_millis(200));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = launchctl(&["bootout", &service]);
        let _ = remove_socket(Some(uid));
        let mut rollback_error = None;
        for (target, backup, exists) in changes.into_iter().rev() {
            if let Err(e) = files::remove_if_exists(&target) {
                rollback_error = Some(e);
                continue;
            }
            if exists && let Err(e) = fs::rename(backup, target) {
                rollback_error = Some(e.into());
            }
        }
        if loaded && let Err(e) = launchctl(&["bootstrap", "system", PLIST_PATH]) {
            rollback_error = Some(e);
        }
        if let Some(rollback_error) = rollback_error {
            let retained = stage.keep();
            return Err(error).context(format!(
                "rollback incomplete; protected backups retained at {}: {rollback_error}",
                retained.display()
            ));
        }
        return Err(error);
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let _lock = install_lock()?;
    files::protected_tree(Path::new(ROOT))?;
    let installation: Installation = files::read_json(&Path::new(ROOT).join("installation.json"))?;
    let service = format!("system/{LABEL}");
    if launchctl(&["print", &service]).is_ok() {
        launchctl(&["bootout", &service])?;
    }
    ensure!(
        launchctl(&["print", &service]).is_err(),
        "service is still loaded"
    );
    crate::process::recover_owned_process(Path::new(ROOT))?;
    crate::network::NetworkManager::new(Path::new(ROOT)).restore()?;
    remove_socket(Some(installation.uid))?;
    for path in [PLIST_PATH, HELPER_PATH] {
        files::remove_if_exists(Path::new(path))?;
    }
    Ok(())
}
