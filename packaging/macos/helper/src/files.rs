use anyhow::{Context, Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path},
};

pub fn protected_info(path: &Path, info: &Metadata) -> Result<()> {
    ensure!(
        info.uid() == 0 && info.mode() & 0o022 == 0 && !info.file_type().is_symlink(),
        "unsafe ownership or permissions: {}",
        path.display()
    );
    ensure!(
        !info.is_file() || info.nlink() == 1,
        "hard-linked file: {}",
        path.display()
    );
    use std::os::unix::fs::FileTypeExt;
    ensure!(
        info.is_dir() || info.is_file() || info.file_type().is_socket(),
        "unsupported file"
    );
    Ok(())
}

pub fn protected_ancestors(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "protected path must be absolute");
    for current in path.ancestors() {
        let info = fs::symlink_metadata(current)?;
        protected_info(current, &info)?;
        ensure!(info.is_dir(), "protected ancestor is not a directory");
    }
    Ok(())
}

pub fn protected_tree(path: &Path) -> Result<()> {
    protected_ancestors(path)?;
    fn walk(path: &Path) -> Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let info = fs::symlink_metadata(entry.path())?;
            protected_info(&entry.path(), &info)?;
            if info.is_dir() {
                walk(&entry.path())?;
            }
        }
        Ok(())
    }
    walk(path)
}

pub fn mkdir_protected(path: &Path) -> Result<()> {
    if path.exists() {
        return protected_ancestors(path);
    }
    let parent = path.parent().context("directory has no parent")?;
    mkdir_protected(parent)?;
    match fs::create_dir(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(0o700))?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    protected_ancestors(path)
}

pub fn checked_open(path: &Path) -> Result<File> {
    crate::dirfd::ProtectedDir::open(path.parent().context("file has no parent")?)?
        .read_file(Path::new(path.file_name().context("file has no name")?))
}

pub fn atomic_write(path: &Path, data: &[u8], mode: u32) -> Result<()> {
    crate::dirfd::ProtectedDir::open(path.parent().context("file has no parent")?)?.atomic_write(
        Path::new(path.file_name().context("file has no name")?),
        data,
        mode,
    )
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    atomic_write(path, &serde_json::to_vec(value)?, 0o600)
}

pub fn file_hash(path: &Path) -> Result<String> {
    let mut file = checked_open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub fn copy_executable(source: &Path, target: &Path) -> Result<()> {
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(source)?;
    let info = source.metadata()?;
    ensure!(
        info.is_file() && info.len() <= 512 << 20,
        "invalid executable"
    );
    let parent = target.parent().context("executable has no parent")?;
    protected_ancestors(parent)?;
    let mut file = tempfile::Builder::new()
        .prefix(".momo-executable-")
        .tempfile_in(parent)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))?;
    let copied = std::io::copy(
        &mut Read::by_ref(&mut source).take((512 << 20) + 1),
        &mut file,
    )?;
    ensure!(
        copied == info.len() && copied <= 512 << 20,
        "executable changed during copy"
    );
    let after = source.metadata()?;
    ensure!(
        after.len() == info.len()
            && after.mtime() == info.mtime()
            && after.mtime_nsec() == info.mtime_nsec(),
        "executable changed during copy"
    );
    file.as_file().sync_all()?;
    let directory = crate::dirfd::ProtectedDir::open(parent)?;
    directory.rename(
        Path::new(
            file.path()
                .file_name()
                .context("temporary executable missing")?,
        ),
        &directory,
        Path::new(target.file_name().context("executable name missing")?),
    )?;
    Ok(())
}

pub fn safe_relative(path: &str) -> bool {
    if path.is_empty() || path.contains(['\\', '\0']) || path.ends_with('/') || path.contains("//")
    {
        return false;
    }
    let p = Path::new(path);
    p.components().all(|part| match part {
        Component::Normal(part) => part.to_str().is_some_and(|part| {
            !part.starts_with(".momo-") && !["core.sock", "config.yaml", "core.log"].contains(&part)
        }),
        _ => false,
    }) && !path.split('/').any(|part| part == "." || part == "..")
}

pub fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let file = checked_open(path)?;
    ensure!(
        file.metadata()?.len() <= 16 << 20,
        "state metadata exceeds limit"
    );
    Ok(serde_json::from_reader(std::io::BufReader::new(file))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copied_executable_is_protected_and_byte_identical() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let parent = ["/root", "/var/lib", "/Library/Application Support"]
            .into_iter()
            .find(|p| protected_ancestors(Path::new(p)).is_ok())
            .unwrap();
        let root = tempfile::tempdir_in(parent).unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        atomic_write(&source, b"approved executable fixture", 0o700).unwrap();
        copy_executable(&source, &target).unwrap();
        assert_eq!(file_hash(&source).unwrap(), file_hash(&target).unwrap());
        assert_eq!(fs::metadata(target).unwrap().mode() & 0o777, 0o700);
    }
    #[test]
    fn snapshot_paths() {
        for p in [
            "../etc/passwd",
            "/etc/passwd",
            "a/../b",
            "a//b",
            "a\\b",
            "",
            ".",
            "config.yaml",
            "x/core.sock",
            "x/.momo-backup",
            "a\0b",
            "a/./b",
        ] {
            assert!(!safe_relative(p), "{p}");
        }
        for p in [
            "providers/a.yaml",
            "traffic-history.db",
            "cache.db-wal",
            "geoip.metadb",
        ] {
            assert!(safe_relative(p), "{p}");
        }
    }
}
