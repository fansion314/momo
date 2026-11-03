use super::*;
use std::{
    io::{BufRead, BufReader},
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
