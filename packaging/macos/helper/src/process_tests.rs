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

// Compile a direct executable so process start/executable identity never changes
// through a shebang interpreter or an exec wrapper during the recovery test.
const CORE_FIXTURE: &str = r#"
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted = 0;
static void stop_fixture(int signal_number) { (void) signal_number; interrupted = 1; }
static void update_runtime(const char *work) {
    char path[4096], configuration[128] = {0};
    if (snprintf(path, sizeof path, "%s/config.yaml", work) >= (int) sizeof path) exit(2);
    FILE *input = fopen(path, "r");
    if (!input) exit(2);
    if (fread(configuration, 1, sizeof configuration - 1, input) == 0) exit(2);
    fclose(input);
    if (snprintf(path, sizeof path, "%s/../fixture-runtime.json", work) >= (int) sizeof path) exit(2);
    int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (descriptor < 0) exit(2);
    FILE *output = fdopen(descriptor, "w");
    if (!output) exit(2);
    const char *key = getenv("CLASH_AGE_SECRET_KEY");
    // All fixture configurations and keys are fixed ASCII constants.
    fprintf(output, "{\"config\":\"%s\",\"key\":\"%s\"}", configuration, key ? key : "");
    if (fclose(output) != 0) exit(2);
}
int main(int argc, char **argv) {
    const char *work = NULL, *socket_path = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-t") == 0) return 0;
        if (strcmp(argv[i], "-d") == 0 && i + 1 < argc) work = argv[++i];
        else if (strcmp(argv[i], "-ext-ctl-unix") == 0 && i + 1 < argc) socket_path = argv[++i];
    }
    if (!work || !socket_path) return 2;
    struct sigaction action = {0};
    action.sa_handler = stop_fixture;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) != 0) return 2;
    update_runtime(work);
    int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) return 2;
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    if (strlen(socket_path) >= sizeof address.sun_path) return 2;
    memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
    if (bind(listener, (struct sockaddr *) &address, sizeof address) != 0 || listen(listener, 8) != 0) return 2;
    while (!interrupted) {
        fd_set descriptors;
        FD_ZERO(&descriptors);
        FD_SET(listener, &descriptors);
        struct timeval timeout = {.tv_sec = 0, .tv_usec = 10000};
        if (select(listener + 1, &descriptors, NULL, NULL, &timeout) <= 0) continue;
        int client = accept(listener, NULL, NULL);
        if (client < 0) continue;
        char request[16384] = {0};
        size_t used = 0;
        while (used < sizeof request - 1 && strstr(request, "\r\n\r\n") == NULL) {
            ssize_t count = read(client, request + used, 1);
            if (count <= 0) break;
            used += (size_t) count;
        }
        const char *length_header = strstr(request, "Content-Length:");
        size_t body_size = length_header ? (size_t) strtoul(length_header + 15, NULL, 10) : 0;
        char buffer[1024];
        while (body_size > 0) {
            size_t count = body_size < sizeof buffer ? body_size : sizeof buffer;
            ssize_t received = read(client, buffer, count);
            if (received <= 0) break;
            body_size -= (size_t) received;
        }
        if (strncmp(request, "PUT /configs", 12) == 0) update_runtime(work);
        const char response[] = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        if (write(client, response, sizeof response - 1) < 0) { close(client); continue; }
        close(client);
    }
    close(listener);
    unlink(socket_path);
    return 0;
}
"#;

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
    let Some(build) = protected_root() else {
        return;
    };
    let source = build.path().join("core-fixture.c");
    let executable = build.path().join("core-fixture");
    fs::write(&source, CORE_FIXTURE).unwrap();
    let compiled = Command::new("/usr/bin/cc")
        .args(["-std=c11", "-Wall", "-Wextra", "-Werror"])
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "core fixture compilation failed: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
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
            files::copy_executable(&executable, &core).unwrap();
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
