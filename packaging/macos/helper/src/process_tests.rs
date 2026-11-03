use super::*;
use std::{
    io::{BufRead, BufReader},
    os::unix::net::UnixListener,
    process::{Child, Command},
};

fn protected_root() -> Option<tempfile::TempDir> {
    if unsafe { libc::geteuid() } != 0 {
        return None;
    }
    for parent in ["/root", "/var/lib", "/Library/Application Support"] {
        if files::protected_ancestors(Path::new(parent)).is_ok() {
            return tempfile::Builder::new()
                .prefix("momo-process-test-")
                .tempdir_in(parent)
                .ok();
        }
    }
    None
}

#[test]
fn bounded_log_concurrent_and_oversized_tail() {
    let Some(root) = protected_root() else {
        return;
    };
    let path = root.path().join("core.log");
    let log = Arc::new(Mutex::new(BoundedLog::new(&path, 64).unwrap()));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let log = log.clone();
            thread::spawn(move || {
                for _ in 0..20 {
                    log.lock().unwrap().write(&[b'x'; 32]).unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert!(fs::metadata(&path).unwrap().len() <= 64);
    log.lock().unwrap().write(&[b'y'; 1024]).unwrap();
    assert_eq!(log.lock().unwrap().read().unwrap(), "y".repeat(64));
    assert!(fs::metadata(&path).unwrap().len() <= 64);
    drop(log);
    let mut reopened = BoundedLog::new(&path, 64).unwrap();
    assert_eq!(reopened.read().unwrap(), "y".repeat(64));
    reopened.write(b"new").unwrap();
    assert_eq!(reopened.read().unwrap(), "new");
}

static INTERRUPTED: AtomicBool = AtomicBool::new(false);
extern "C" fn interrupt_fixture(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Release);
}

#[test]
fn process_fixture() {
    if std::env::var("MOMO_HELPER_PROCESS_FIXTURE").as_deref() != Ok("1") {
        return;
    }
    assert_ne!(
        unsafe {
            libc::signal(
                libc::SIGINT,
                interrupt_fixture as *const () as libc::sighandler_t,
            )
        },
        libc::SIG_ERR
    );
    println!("momo-process-ready");
    std::io::stdout().flush().unwrap();
    while !INTERRUPTED.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(10));
    }
}

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn recovery_compares_process_start_identity_before_signalling() {
    let Some(root) = protected_root() else {
        return;
    };
    let mut child = KillOnDrop(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process::tests::process_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MOMO_HELPER_PROCESS_FIXTURE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (ready, received) = std::sync::mpsc::channel();
    let reader = thread::spawn(move || {
        let mut announced = false;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !announced && line.contains("momo-process-ready") => {
                    let _ = ready.send(());
                    announced = true;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });
    received
        .recv_timeout(Duration::from_secs(5))
        .expect("process fixture did not become ready");
    let pid = child.0.id() as i32;
    let identity = native::process_identity(pid).unwrap();
    let record = root.path().join("process.json");
    files::write_json(
        &record,
        &ProcessRecord {
            pid,
            identity: format!("{identity}-different-start"),
        },
    )
    .unwrap();
    recover_owned_process(root.path()).unwrap();
    assert_eq!(native::process_identity(pid).unwrap(), identity);
    assert!(child.0.try_wait().unwrap().is_none());
    files::write_json(&record, &ProcessRecord { pid, identity }).unwrap();
    recover_owned_process(root.path()).unwrap();
    let status = child.0.wait().unwrap();
    assert!(
        status.success(),
        "owned process did not receive graceful SIGINT: {status}"
    );
    reader.join().unwrap();
    assert!(!record.exists());
}

#[test]
fn managed_core_fixture() {
    let Some(root) = std::env::var_os("MOMO_HELPER_MANAGED_FIXTURE_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    unsafe {
        libc::signal(
            libc::SIGINT,
            interrupt_fixture as *const () as libc::sighandler_t,
        );
    }
    let update_runtime = || {
        let config = fs::read_to_string(root.join("data/config.yaml")).unwrap();
        files::write_json(
            &root.join("fixture-runtime.json"),
            &serde_json::json!({
                "config": config,
                "key": std::env::var("CLASH_AGE_SECRET_KEY").unwrap_or_default(),
            }),
        )
        .unwrap();
    };
    update_runtime();
    let listener = UnixListener::bind(root.join("data/core.sock")).unwrap();
    listener.set_nonblocking(true).unwrap();
    while !INTERRUPTED.load(Ordering::Acquire) {
        let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            Err(e) => panic!("fixture accept: {e}"),
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let reload = line.starts_with("PUT /configs");
        let mut length = 0;
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
        }
        let mut bytes = vec![0u8; length];
        reader.read_exact(&mut bytes).unwrap();
        if reload {
            update_runtime();
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
    }
}

fn quote_fixture(value: &Path) -> String {
    format!("'{}'", value.to_str().unwrap().replace('\'', "'\\''"))
}

struct StopFixtureService(Arc<Service>);
impl Drop for StopFixtureService {
    fn drop(&mut self) {
        let mut life = self.0.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let _ = life.stop(&self.0);
    }
}

#[test]
fn metadata_commit_failure_restores_runtime_files_and_migration_state() {
    use crate::snapshot::{self, CommitFailure};
    for (start, changed_key, cancel) in [
        (true, false, false),
        (false, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        for point in [CommitFailure::Imports, CommitFailure::Migration] {
            let Some(root) = protected_root() else {
                return;
            };
            let root_path = root.path();
            files::mkdir_protected(&root_path.join("data")).unwrap();
            files::atomic_write(
                &root_path.join("data/config.yaml"),
                b"old configuration",
                0o600,
            )
            .unwrap();
            files::atomic_write(&root_path.join("data/resource.txt"), b"old resource", 0o600)
                .unwrap();
            let original_imports = br#"{"resource.txt":"previous digest"}"#;
            files::atomic_write(&root_path.join("imports.json"), original_imports, 0o600).unwrap();
            if !start {
                files::atomic_write(&root_path.join("migrated"), b"legacy marker", 0o600).unwrap();
            }
            let core = root_path.join("mihomomo");
            let script = format!(
                "#!/bin/sh\nfor argument do if [ \"$argument\" = -t ]; then exit 0; fi; done\nMOMO_HELPER_MANAGED_FIXTURE_ROOT={} {} --exact process::tests::managed_core_fixture --nocapture --test-threads=1 &\nchild=$!\ntrap 'kill -INT \"$child\"; wait \"$child\"; exit 0' INT TERM\nwait \"$child\"\n",
                quote_fixture(root_path),
                quote_fixture(&std::env::current_exe().unwrap()),
            );
            files::atomic_write(&core, script.as_bytes(), 0o700).unwrap();
            let shared = Service::new(
                root_path,
                Installation {
                    uid: 501,
                    helper_hash: String::new(),
                    core_hash: files::file_hash(&core).unwrap(),
                    core_version: "1.19.33".into(),
                },
            )
            .unwrap();
            let _stop_fixture = StopFixtureService(shared.clone());
            let cancelled = Arc::new(AtomicBool::new(false));
            let mut life = shared.lifecycle.lock().unwrap();
            if !start {
                life.start(&shared, "old key", &cancelled).unwrap();
            }
            let old_pid = life.core.as_ref().map(|core| core.pid);
            let input = serde_json::to_vec(&serde_json::json!({
                "config":"new configuration",
                "ageSecretKey":if changed_key {"new key"} else {"old key"},
                "files":[{"path":"resource.txt","data":"bmV3IHJlc291cmNl"}],
            }))
            .unwrap();
            let mut input =
                snapshot::parse(std::io::Cursor::new(input), root_path, cancelled.clone()).unwrap();
            snapshot::fail_next_commit(point);
            if cancel {
                snapshot::cancel_on_next_commit(cancelled.clone());
            }
            let result = life.snapshot(&shared, &mut input, start, &cancelled);
            assert!(result.is_err(), "metadata failure must be reported");
            eprintln!(
                "SNAPSHOT_FAILURE start={start} changed_key={changed_key} cancel={cancel}: {:#}",
                result.as_ref().unwrap_err()
            );
            assert_eq!(
                fs::read(root_path.join("data/config.yaml")).unwrap(),
                b"old configuration"
            );
            assert_eq!(
                fs::read(root_path.join("data/resource.txt")).unwrap(),
                b"old resource"
            );
            assert_eq!(
                fs::read(root_path.join("imports.json")).unwrap(),
                original_imports
            );
            if start {
                assert!(!root_path.join("migrated").exists());
            } else {
                assert_eq!(
                    fs::read(root_path.join("migrated")).unwrap(),
                    b"legacy marker"
                );
            }
            if !start && !cancel {
                assert!(shared.running.load(Ordering::Acquire));
                assert_ne!(life.core.as_ref().map(|core| core.pid), old_pid);
                let runtime: serde_json::Value =
                    files::read_json(&root_path.join("fixture-runtime.json")).unwrap();
                assert_eq!(runtime["config"], "old configuration");
                assert_eq!(runtime["key"], "old key");
            } else {
                assert!(!shared.running.load(Ordering::Acquire));
                assert!(life.core.is_none());
            }
            life.stop(&shared).unwrap();
        }
    }
}
