use anyhow::{Context, Result, ensure};
use std::{
    ffi::{CString, OsStr},
    fs::{File, Metadata},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};

/// Every lookup stays relative to an already validated directory descriptor.
pub struct ProtectedDir(File);

#[cfg(test)]
thread_local! {
    static FAIL_RENAME_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub fn fail_next_rename_sync() {
    FAIL_RENAME_SYNC.with(|flag| flag.set(true));
}

fn name(value: &OsStr) -> Result<CString> {
    ensure!(!value.is_empty(), "empty path component");
    Ok(CString::new(value.as_bytes())?)
}

fn protected(info: &Metadata, directory: bool) -> Result<()> {
    ensure!(
        info.uid() == 0 && info.mode() & 0o022 == 0,
        "unsafe file ownership or mode: uid={} mode={:o}",
        info.uid(),
        info.mode()
    );
    if directory {
        ensure!(info.is_dir(), "expected protected directory");
    } else {
        ensure!(
            info.is_file() && info.nlink() == 1,
            "expected singly linked regular file"
        );
    }
    Ok(())
}

fn owned_file(fd: libc::c_int) -> std::io::Result<File> {
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // A successful openat/open returned a new descriptor owned by this File.
    Ok(unsafe { File::from_raw_fd(fd) })
}

impl ProtectedDir {
    pub fn open(path: &Path) -> Result<Self> {
        ensure!(path.is_absolute(), "protected directory must be absolute");
        let root = CString::new("/")?;
        // The root has no caller-controlled parent component.
        let file = owned_file(unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        })?;
        protected(&file.metadata()?, true)?;
        let mut current = Self(file);
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(part) => current = current.child(part, false)?,
                _ => anyhow::bail!("noncanonical protected directory path"),
            }
        }
        Ok(current)
    }

    fn child(&self, part: &OsStr, create: bool) -> Result<Self> {
        let part = name(part)?;
        if create {
            // The parent descriptor remains live throughout creation and open.
            let result = unsafe { libc::mkdirat(self.0.as_raw_fd(), part.as_ptr(), 0o700) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(error.into());
                }
            } else {
                self.sync_all()?;
            }
        }
        let file = owned_file(unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                part.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })?;
        protected(&file.metadata()?, true)?;
        Ok(Self(file))
    }

    pub fn subdir(&self, relative: &Path, create: bool) -> Result<Self> {
        ensure!(!relative.is_absolute(), "expected relative directory");
        let mut directory = Self(self.0.try_clone()?);
        for part in relative.components() {
            match part {
                Component::Normal(part) => directory = directory.child(part, create)?,
                _ => anyhow::bail!("invalid relative directory"),
            }
        }
        Ok(directory)
    }

    fn parent(&self, relative: &Path, create: bool) -> Result<(Self, CString)> {
        ensure!(!relative.is_absolute(), "expected relative file path");
        ensure!(
            relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
            "invalid relative file path"
        );
        let filename = name(relative.file_name().context("file name required")?)?;
        let parent = self.subdir(relative.parent().context("parent required")?, create)?;
        Ok((parent, filename))
    }

    pub fn read_file(&self, relative: &Path) -> Result<File> {
        let (parent, filename) = self.parent(relative, false)?;
        // O_NONBLOCK prevents an unexpected FIFO from hanging before fstat.
        let file = owned_file(unsafe {
            libc::openat(
                parent.0.as_raw_fd(),
                filename.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        })?;
        protected(&file.metadata()?, false)?;
        Ok(file)
    }

    pub fn file_metadata(&self, relative: &Path) -> Result<Option<Metadata>> {
        match self.read_file(relative) {
            Ok(file) => Ok(Some(file.metadata()?)),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub fn rename(&self, from: &Path, destination: &Self, to: &Path) -> Result<()> {
        ensure!(self.file_metadata(from)?.is_some(), "rename source missing");
        destination.file_metadata(to)?;
        let (source_parent, source_name) = self.parent(from, false)?;
        let (target_parent, target_name) = destination.parent(to, false)?;
        let result = unsafe {
            libc::renameat(
                source_parent.0.as_raw_fd(),
                source_name.as_ptr(),
                target_parent.0.as_raw_fd(),
                target_name.as_ptr(),
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        #[cfg(test)]
        if FAIL_RENAME_SYNC.with(|flag| flag.replace(false)) {
            return Err(std::io::Error::other("injected post-rename sync failure").into());
        }
        source_parent.sync_all()?;
        target_parent.sync_all()
    }

    pub fn remove_file(&self, relative: &Path) -> Result<()> {
        if self.file_metadata(relative)?.is_none() {
            return Ok(());
        }
        let (parent, filename) = self.parent(relative, false)?;
        if unsafe { libc::unlinkat(parent.0.as_raw_fd(), filename.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        parent.sync_all()
    }

    pub fn atomic_write(&self, relative: &Path, data: &[u8], mode: u32) -> Result<()> {
        self.write_from(relative, &mut &*data, mode)
    }

    pub fn write_from(&self, relative: &Path, reader: &mut impl Read, mode: u32) -> Result<()> {
        ensure!(mode & 0o022 == 0, "unsafe write permissions");
        let (parent, filename) = self.parent(relative, true)?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow::anyhow!("secure randomness unavailable"))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let temporary = CString::new(format!(".momo-write-{suffix}"))?;
        let mut file = owned_file(unsafe {
            libc::openat(
                parent.0.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode,
            )
        })?;
        let result = (|| -> Result<()> {
            std::io::copy(reader, &mut file)?;
            file.flush()?;
            file.sync_all()?;
            if unsafe {
                libc::renameat(
                    parent.0.as_raw_fd(),
                    temporary.as_ptr(),
                    parent.0.as_raw_fd(),
                    filename.as_ptr(),
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            #[cfg(test)]
            if FAIL_RENAME_SYNC.with(|flag| flag.replace(false)) {
                return Err(std::io::Error::other("injected post-rename sync failure").into());
            }
            parent.sync_all()
        })();
        if result.is_err() {
            unsafe {
                libc::unlinkat(parent.0.as_raw_fd(), temporary.as_ptr(), 0);
            }
        }
        result
    }

    pub fn sync_all(&self) -> Result<()> {
        Ok(self.0.sync_all()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn refuses_untrusted_components_and_anchors_renamed_directories() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let parent = ["/root", "/var/lib", "/Library/Application Support"]
            .into_iter()
            .find(|p| crate::files::protected_ancestors(Path::new(p)).is_ok())
            .expect("protected root test ancestor");
        let base = tempfile::tempdir_in(parent).unwrap();
        let anchored = base.path().join("anchored");
        std::fs::create_dir(&anchored).unwrap();
        std::fs::set_permissions(&anchored, std::fs::Permissions::from_mode(0o700)).unwrap();
        let directory = ProtectedDir::open(&anchored).unwrap();
        directory
            .atomic_write(Path::new("a/value"), b"safe", 0o600)
            .unwrap();
        let moved = base.path().join("moved");
        std::fs::rename(&anchored, &moved).unwrap();
        symlink("/etc", &anchored).unwrap();
        directory
            .atomic_write(Path::new("a/value"), b"anchored", 0o600)
            .unwrap();
        assert_eq!(std::fs::read(moved.join("a/value")).unwrap(), b"anchored");
        assert!(ProtectedDir::open(&anchored).is_err());
        assert!(directory.read_file(Path::new("../etc/passwd")).is_err());
        symlink("/etc/passwd", moved.join("a/link")).unwrap();
        assert!(directory.read_file(Path::new("a/link")).is_err());
        std::fs::hard_link(moved.join("a/value"), moved.join("a/hard")).unwrap();
        assert!(directory.read_file(Path::new("a/hard")).is_err());
        std::fs::create_dir(moved.join("unsafe")).unwrap();
        std::fs::set_permissions(moved.join("unsafe"), std::fs::Permissions::from_mode(0o777))
            .unwrap();
        assert!(directory.subdir(Path::new("unsafe"), false).is_err());
    }
}
