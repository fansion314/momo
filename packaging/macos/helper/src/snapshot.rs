use crate::{dirfd::ProtectedDir, files};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{BufReader, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use zeroize::Zeroizing;

pub struct Snapshot {
    pub config: String,
    pub key: Zeroizing<String>,
    files: Vec<StagedFile>,
    directory: tempfile::TempDir,
}
struct StagedFile {
    path: String,
    source: PathBuf,
    digest: String,
    import_only: bool,
}

struct Parser<R> {
    reader: R,
    look: Option<u8>,
    cancelled: Arc<AtomicBool>,
    decoded: u64,
}
impl<R: Read> Parser<R> {
    fn byte(&mut self) -> Result<Option<u8>> {
        ensure!(
            !self.cancelled.load(Ordering::Relaxed),
            "snapshot cancelled"
        );
        if let Some(byte) = self.look.take() {
            return Ok(Some(byte));
        }
        let mut byte = [0];
        Ok(if self.reader.read(&mut byte)? == 0 {
            None
        } else {
            Some(byte[0])
        })
    }
    fn nonspace(&mut self) -> Result<Option<u8>> {
        loop {
            let b = self.byte()?;
            if !b.is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n')) {
                return Ok(b);
            }
        }
    }
    fn expect(&mut self, byte: u8) -> Result<()> {
        ensure!(self.nonspace()? == Some(byte), "invalid snapshot JSON");
        Ok(())
    }
    fn string_to(&mut self, mut emit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
        self.expect(b'"')?;
        loop {
            let byte = self.byte()?.context("truncated JSON string")?;
            match byte {
                b'"' => return Ok(()),
                b'\\' => {
                    let byte = self.byte()?.context("truncated JSON escape")?;
                    match byte {
                        b'"' | b'\\' | b'/' => emit(&[byte])?,
                        b'b' => emit(&[8])?,
                        b'f' => emit(&[12])?,
                        b'n' => emit(b"\n")?,
                        b'r' => emit(b"\r")?,
                        b't' => emit(b"\t")?,
                        b'u' => {
                            let mut code = self.hex4()?;
                            if (0xd800..=0xdbff).contains(&code) {
                                ensure!(
                                    self.byte()? == Some(b'\\') && self.byte()? == Some(b'u'),
                                    "invalid JSON surrogate"
                                );
                                let low = self.hex4()?;
                                ensure!((0xdc00..=0xdfff).contains(&low), "invalid JSON surrogate");
                                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                            }
                            let ch = char::from_u32(code).context("invalid JSON Unicode")?;
                            emit(ch.encode_utf8(&mut [0; 4]).as_bytes())?;
                        }
                        _ => bail!("invalid JSON escape"),
                    }
                }
                0..=31 => bail!("invalid JSON control character"),
                _ => emit(&[byte])?,
            }
        }
    }
    fn hex4(&mut self) -> Result<u32> {
        let mut code = 0;
        for _ in 0..4 {
            code = code * 16
                + (self.byte()?.context("truncated Unicode escape")? as char)
                    .to_digit(16)
                    .context("invalid Unicode escape")?;
        }
        Ok(code)
    }
    fn string(&mut self, max: usize) -> Result<String> {
        let mut bytes = Vec::new();
        self.string_to(|part| {
            ensure!(
                bytes.len() + part.len() <= max,
                "snapshot string exceeds limit"
            );
            bytes.extend_from_slice(part);
            Ok(())
        })?;
        Ok(String::from_utf8(bytes)?)
    }
    fn boolean(&mut self) -> Result<bool> {
        let first = self.nonspace()?;
        let (value, tail): (bool, &[u8]) = match first {
            Some(b't') => (true, b"rue"),
            Some(b'f') => (false, b"alse"),
            _ => bail!("expected JSON boolean"),
        };
        for byte in tail {
            ensure!(self.byte()? == Some(*byte), "invalid JSON boolean");
        }
        Ok(value)
    }
    fn separator(&mut self, end: u8) -> Result<bool> {
        match self.nonspace()? {
            Some(b',') => Ok(true),
            Some(b) if b == end => Ok(false),
            _ => bail!("invalid JSON separator"),
        }
    }
    fn encoded_file(&mut self, path: &Path) -> Result<String> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let mut encoded = Vec::with_capacity(65536);
        let mut decoded = [0u8; 49152];
        let mut count = 0u64;
        let previously_decoded = self.decoded;
        let mut hash = Sha256::new();
        let mut padded = false;
        let mut flush = |encoded: &mut Vec<u8>| -> Result<()> {
            ensure!(!padded, "data after base64 padding");
            let size = STANDARD
                .decode_slice(&*encoded, &mut decoded)
                .map_err(|_| anyhow::anyhow!("invalid snapshot base64"))?;
            padded = encoded.contains(&b'=');
            count += size as u64;
            ensure!(count <= 512 << 20, "snapshot file exceeds limit");
            ensure!(
                previously_decoded + count <= 576 << 20,
                "decoded snapshot exceeds limit"
            );
            hash.update(&decoded[..size]);
            file.write_all(&decoded[..size])?;
            encoded.clear();
            Ok(())
        };
        self.string_to(|part| {
            for &byte in part {
                if byte == b'\r' || byte == b'\n' {
                    continue;
                }
                ensure!(
                    byte.is_ascii_alphanumeric() || b"+/=".contains(&byte),
                    "invalid snapshot base64"
                );
                encoded.push(byte);
                if encoded.len() == 65536 {
                    flush(&mut encoded)?;
                }
            }
            Ok(())
        })?;
        if !encoded.is_empty() {
            flush(&mut encoded)?;
        }
        drop(flush);
        self.decoded += count;
        ensure!(self.decoded <= 576 << 20, "decoded snapshot exceeds limit");
        file.sync_all()?;
        Ok(hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
    fn file(&mut self, directory: &Path, index: usize) -> Result<StagedFile> {
        self.expect(b'{')?;
        let mut seen = HashSet::new();
        let mut path = None;
        let mut digest = None;
        let mut import_only = false;
        let source = directory.join(format!("file-{index}"));
        loop {
            let field = self.string(64)?;
            ensure!(seen.insert(field.clone()), "duplicate snapshot field");
            self.expect(b':')?;
            match field.as_str() {
                "path" => path = Some(self.string(4096)?),
                "data" => digest = Some(self.encoded_file(&source)?),
                "importOnly" => import_only = self.boolean()?,
                _ => bail!("unknown snapshot file field"),
            }
            if !self.separator(b'}')? {
                break;
            }
        }
        let path = path.context("snapshot file path required")?;
        ensure!(
            files::safe_relative(&path) && !path.ends_with(".sock"),
            "invalid snapshot path"
        );
        Ok(StagedFile {
            path,
            source,
            digest: digest.context("snapshot data required")?,
            import_only,
        })
    }
}

pub fn parse(reader: impl Read, root: &Path, cancelled: Arc<AtomicBool>) -> Result<Snapshot> {
    let directory = tempfile::Builder::new()
        .prefix(".momo-snapshot-")
        .tempdir_in(root)?;
    let mut parser = Parser {
        reader: BufReader::with_capacity(65536, reader),
        look: None,
        cancelled,
        decoded: 0,
    };
    parser.expect(b'{')?;
    let mut seen = HashSet::new();
    let mut config = None;
    let mut key = Zeroizing::new(String::new());
    let mut files = Vec::new();
    loop {
        let field = parser.string(64)?;
        ensure!(seen.insert(field.clone()), "duplicate snapshot field");
        parser.expect(b':')?;
        match field.as_str() {
            "config" => config = Some(parser.string(16 << 20)?),
            "ageSecretKey" => key = Zeroizing::new(parser.string(1 << 20)?),
            "files" => {
                parser.expect(b'[')?;
                let next = parser.nonspace()?;
                if next == Some(b']') {
                } else {
                    ensure!(next == Some(b'{'), "invalid snapshot file array");
                    parser.look = Some(b'{');
                    loop {
                        ensure!(files.len() < 20000, "too many snapshot files");
                        files.push(parser.file(directory.path(), files.len())?);
                        if !parser.separator(b']')? {
                            break;
                        }
                    }
                }
            }
            _ => bail!("unknown snapshot field"),
        }
        if !parser.separator(b'}')? {
            break;
        }
    }
    ensure!(parser.nonspace()?.is_none(), "expected one JSON object");
    let config = config.context("snapshot config required")?;
    ensure!(!config.is_empty(), "empty snapshot configuration");
    ensure!(
        parser.decoded + config.len() as u64 <= 576 << 20,
        "decoded snapshot exceeds limit"
    );
    let mut paths = HashSet::new();
    ensure!(
        files.iter().all(|f| paths.insert(f.path.clone())),
        "duplicate snapshot path"
    );
    Ok(Snapshot {
        config,
        key,
        files,
        directory,
    })
}

pub struct Transaction {
    directory: Option<tempfile::TempDir>,
    changes: Vec<(PathBuf, PathBuf, bool)>,
    manifest: BTreeMap<String, String>,
    manifest_path: PathBuf,
    manifest_original: Option<Vec<u8>>,
    manifest_touched: bool,
    finished: bool,
    work: ProtectedDir,
    backups: ProtectedDir,
}
impl Snapshot {
    pub fn stage(&mut self, root: &Path, cancelled: &AtomicBool) -> Result<Transaction> {
        let work = root.join("data");
        let work_directory = ProtectedDir::open(&work)?;
        let manifest_path = root.join("imports.json");
        let manifest_original = if manifest_path.try_exists()? {
            let mut file = files::checked_open(&manifest_path)?;
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take((16 << 20) + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 16 << 20, "import manifest exceeds limit");
            Some(bytes)
        } else {
            None
        };
        let manifest = match &manifest_original {
            Some(bytes) => serde_json::from_slice(bytes)?,
            None => BTreeMap::new(),
        };
        let directory = tempfile::Builder::new()
            .prefix(".momo-transaction-")
            .tempdir_in(root)?;
        let backups = ProtectedDir::open(directory.path())?;
        let mut tx = Transaction {
            directory: Some(directory),
            changes: Vec::new(),
            manifest,
            manifest_path,
            manifest_original,
            manifest_touched: false,
            finished: false,
            work: work_directory,
            backups,
        };
        for (index, entry) in self.files.iter().enumerate() {
            ensure!(!cancelled.load(Ordering::Relaxed), "snapshot cancelled");
            let target = Path::new(&entry.path);
            if tx.work.file_metadata(target)?.is_some() && entry.import_only {
                continue;
            }
            let unchanged = tx.manifest.get(&entry.path) == Some(&entry.digest);
            tx.manifest.insert(entry.path.clone(), entry.digest.clone());
            if tx.work.file_metadata(target)?.is_some() && unchanged {
                continue;
            }
            tx.work
                .subdir(target.parent().context("snapshot parent missing")?, true)?;
            tx.replace(target, &entry.source, index)?;
        }
        let source = self.directory.path().join("config");
        files::atomic_write(&source, self.config.as_bytes(), 0o600)?;
        tx.replace(Path::new("config.yaml"), &source, self.files.len())?;
        Ok(tx)
    }
}
impl Transaction {
    fn replace(&mut self, target: &Path, source: &Path, index: usize) -> Result<()> {
        let backup = PathBuf::from(format!("backup-{index}"));
        let existed = self.work.file_metadata(target)?.is_some();
        // renameat may succeed before directory fsync reports failure. Record the
        // intent first; rollback checks whether the backup was actually created.
        self.changes
            .push((target.to_owned(), backup.clone(), existed));
        if existed {
            self.work.rename(target, &self.backups, &backup)?;
        }
        let source_directory =
            ProtectedDir::open(source.parent().context("snapshot source parent missing")?)?;
        source_directory.rename(
            Path::new(source.file_name().context("source missing")?),
            &self.work,
            target,
        )?;
        Ok(())
    }
    pub fn commit(&mut self) -> Result<()> {
        self.manifest_touched = true;
        files::write_json(&self.manifest_path, &self.manifest)?;
        self.finished = true;
        self.directory.take();
        Ok(())
    }
    pub fn rollback(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        let mut error = None;
        for (target, backup, existed) in self.changes.iter().rev() {
            if *existed {
                match self.backups.file_metadata(backup) {
                    Ok(None) => continue,
                    Ok(Some(_)) => {}
                    Err(e) => {
                        error = Some(e);
                        continue;
                    }
                }
            }
            if let Err(e) = self.work.remove_file(target) {
                error = Some(e);
                continue;
            }
            if *existed && let Err(e) = self.backups.rename(backup, &self.work, target) {
                error = Some(e);
            }
        }
        if self.manifest_touched {
            let restored = match &self.manifest_original {
                Some(bytes) => files::atomic_write(&self.manifest_path, bytes, 0o600),
                None => ProtectedDir::open(
                    self.manifest_path
                        .parent()
                        .context("manifest parent missing")?,
                )?
                .remove_file(Path::new("imports.json")),
            };
            if let Err(e) = restored {
                error = Some(e);
            }
        }
        self.finished = true;
        if let Some(error) = error {
            if let Some(directory) = self.directory.take() {
                let _ = directory.keep();
            }
            return Err(error).context("snapshot rollback incomplete; protected backups retained");
        }
        self.directory.take();
        Ok(())
    }
}
impl Drop for Transaction {
    fn drop(&mut self) {
        let _ = self.rollback();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn protected_root() -> Option<tempfile::TempDir> {
        if unsafe { libc::geteuid() } != 0 {
            return None;
        }
        let parent = ["/root", "/var/lib", "/Library/Application Support"]
            .into_iter()
            .find(|p| files::protected_ancestors(Path::new(p)).is_ok())?;
        tempfile::tempdir_in(parent).ok()
    }
    fn parsed(input: &str) -> Result<Snapshot> {
        let mut file = tempfile::tempfile()?;
        file.write_all(input.as_bytes())?;
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0))?;
        parse(
            file,
            &std::env::temp_dir(),
            Arc::new(AtomicBool::new(false)),
        )
    }
    #[test]
    fn strict_streamed_parser() {
        let snapshot=parsed(r#"{"files":[{"data":"aGVsbG8=","path":"providers/a.yaml"}],"config":"mode: direct\n"}"#).unwrap();
        assert_eq!(fs::read(&snapshot.files[0].source).unwrap(), b"hello");
        for input in [
            r#"{"config":"x","unknown":1}"#,
            r#"{"config":"x","config":"y"}"#,
            r#"{"config":"x"} {}"#,
            r#"{"config":"x","files":[{"path":"../evil","data":"eA=="}]}"#,
            r#"{"config":"x","files":[{"path":"a","data":"eA==eA=="}]}"#,
        ] {
            assert!(parsed(input).is_err(), "{input}");
        }
        for whitespace in ['\u{b}', '\u{c}'] {
            assert!(parsed(&format!("{{{whitespace}\"config\":\"x\"}}")).is_err());
        }
    }

    #[test]
    fn transaction_preserves_migration_and_downloaded_assets() {
        let Some(root) = protected_root() else {
            return;
        };
        let work = root.path().join("data");
        files::mkdir_protected(&work).unwrap();
        files::atomic_write(&work.join("cache.db"), b"old", 0o600).unwrap();
        let make = |data: &str, import: bool| {
            let text=serde_json::json!({"config":"mode: direct\n","files":[{"path":"cache.db","data":data,"importOnly":import}]}).to_string();
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(text.as_bytes()).unwrap();
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(0)).unwrap();
            parse(file, root.path(), Arc::new(AtomicBool::new(false))).unwrap()
        };
        let cancelled = AtomicBool::new(false);
        let mut input = make("bmV3", false);
        let mut tx = input.stage(root.path(), &cancelled).unwrap();
        tx.rollback().unwrap();
        assert_eq!(fs::read(work.join("cache.db")).unwrap(), b"old");
        let mut input = make("bmV3", true);
        input
            .stage(root.path(), &cancelled)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read(work.join("cache.db")).unwrap(), b"old");
        let mut input = make("bmV3", false);
        input
            .stage(root.path(), &cancelled)
            .unwrap()
            .commit()
            .unwrap();
        files::atomic_write(&work.join("cache.db"), b"downloaded", 0o600).unwrap();
        let mut input = make("bmV3", false);
        input
            .stage(root.path(), &cancelled)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read(work.join("cache.db")).unwrap(), b"downloaded");
        let mut input = make("Y2hhbmdlZA==", false);
        input
            .stage(root.path(), &cancelled)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read(work.join("cache.db")).unwrap(), b"changed");
        std::os::unix::fs::symlink("/etc/passwd", work.join("cache.db.link")).unwrap();
        let mut input =
            parsed(r#"{"config":"x","files":[{"path":"cache.db.link","data":"eA=="}]}"#).unwrap();
        assert!(input.stage(root.path(), &cancelled).is_err());
        fs::set_permissions(work.join("cache.db"), fs::Permissions::from_mode(0o622)).unwrap();
        let mut input = make("bmV3", false);
        assert!(input.stage(root.path(), &cancelled).is_err());
    }

    #[test]
    fn backup_rename_sync_failure_restores_original_bytes() {
        let Some(root) = protected_root() else {
            return;
        };
        files::mkdir_protected(&root.path().join("data")).unwrap();
        files::atomic_write(&root.path().join("data/cache.db"), b"original", 0o600).unwrap();
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(
            br#"{"config":"mode: direct\n","files":[{"path":"cache.db","data":"bmV3"}]}"#,
        )
        .unwrap();
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut snapshot = parse(file, root.path(), Arc::new(AtomicBool::new(false))).unwrap();
        crate::dirfd::fail_next_rename_sync();
        assert!(
            snapshot
                .stage(root.path(), &AtomicBool::new(false))
                .is_err()
        );
        assert_eq!(
            fs::read(root.path().join("data/cache.db")).unwrap(),
            b"original"
        );
        assert!(!root.path().join("data/config.yaml").exists());
    }

    #[test]
    fn manifest_write_sync_failure_rolls_back_manifest_and_files() {
        let Some(root) = protected_root() else {
            return;
        };
        files::mkdir_protected(&root.path().join("data")).unwrap();
        files::atomic_write(&root.path().join("data/cache.db"), b"old", 0o600).unwrap();
        let original = br#"{"cache.db":"old digest"}"#;
        files::atomic_write(&root.path().join("imports.json"), original, 0o600).unwrap();
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(
            br#"{"config":"mode: direct\n","files":[{"path":"cache.db","data":"bmV3"}]}"#,
        )
        .unwrap();
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut snapshot = parse(file, root.path(), Arc::new(AtomicBool::new(false))).unwrap();
        let mut transaction = snapshot
            .stage(root.path(), &AtomicBool::new(false))
            .unwrap();
        crate::dirfd::fail_next_rename_sync();
        assert!(transaction.commit().is_err());
        transaction.rollback().unwrap();
        assert_eq!(fs::read(root.path().join("data/cache.db")).unwrap(), b"old");
        assert_eq!(
            fs::read(root.path().join("imports.json")).unwrap(),
            original
        );
    }

    #[test]
    fn large_snapshot_has_bounded_memory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("request.json");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(
            b"{\"config\":\"mode: direct\\n\",\"files\":[{\"path\":\"provider.bin\",\"data\":\"",
        )
        .unwrap();
        let chunk = [b'A'; 65536];
        let encoded = 89_478_484u64;
        for _ in 0..encoded / 65536 {
            file.write_all(&chunk).unwrap();
        }
        file.write_all(&chunk[..(encoded % 65536) as usize])
            .unwrap();
        file.write_all(b"\"}]}").unwrap();
        file.sync_all().unwrap();
        drop(file);
        fn peak() -> u64 {
            let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
            assert_eq!(
                unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
                0
            );
            let value = unsafe { usage.assume_init() }.ru_maxrss as u64;
            if cfg!(target_os = "macos") {
                value
            } else {
                value * 1024
            }
        }
        let before = peak();
        let snapshot = parse(
            fs::File::open(&path).unwrap(),
            directory.path(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let after = peak();
        let decoded = fs::metadata(&snapshot.files[0].source).unwrap().len();
        assert_eq!(decoded, 67_108_863);
        assert!(
            after.saturating_sub(before) < 32 << 20,
            "snapshot RSS grew by {}",
            after.saturating_sub(before)
        );
        println!(
            "SNAPSHOT_MEMORY {}",
            serde_json::json!({"wireBytes":encoded,"decodedBytes":decoded,"peakBeforeBytes":before,"peakAfterBytes":after,"peakGrowthBytes":after.saturating_sub(before)})
        );
    }
}
