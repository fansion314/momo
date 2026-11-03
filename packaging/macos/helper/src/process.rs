use crate::{
    Installation, files, install, native, network::NetworkManager, server::Service,
    snapshot::Snapshot,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::{fs::OpenOptionsExt, io::AsRawFd, net::UnixStream},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
struct ProcessRecord {
    pid: i32,
    identity: String,
}

pub fn stop_pid(pid: i32, identity: &str, grace: Duration) -> Result<()> {
    ensure!(pid > 1, "invalid managed PID");
    if native::process_identity(pid).ok().as_deref() != Some(identity) {
        return Ok(());
    }
    let signalled = unsafe { libc::kill(pid, libc::SIGINT) };
    if signalled != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
        return Err(std::io::Error::last_os_error().into());
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if native::process_identity(pid).ok().as_deref() != Some(identity) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    if native::process_identity(pid).ok().as_deref() == Some(identity) {
        let signalled = unsafe { libc::kill(pid, libc::SIGKILL) };
        if signalled != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}

pub fn recover_owned_process(root: &Path) -> Result<()> {
    let path = root.join("process.json");
    if !path.try_exists()? {
        return Ok(());
    }
    let record: ProcessRecord = files::read_json(&path)?;
    ensure!(
        record.pid > 1 && !record.identity.is_empty(),
        "invalid process recovery record"
    );
    stop_pid(record.pid, &record.identity, Duration::from_secs(6))?;
    files::remove_if_exists(&path)
}

pub struct BoundedLog {
    file: File,
    limit: u64,
    size: u64,
}
impl BoundedLog {
    pub fn new(path: &Path, limit: u64) -> Result<Self> {
        files::protected_ancestors(path.parent().context("log parent missing")?)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        files::protected_info(path, &file.metadata()?)?;
        let mut log = Self {
            size: file.metadata()?.len(),
            file,
            limit,
        };
        if log.size > limit {
            log.file.set_len(0)?;
            log.size = 0;
        }
        Ok(log)
    }
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        let data = &data[data.len().saturating_sub(self.limit as usize)..];
        if self.size + data.len() as u64 > self.limit {
            self.file.set_len(0)?;
            self.size = 0;
        }
        self.file.seek(SeekFrom::Start(self.size))?;
        self.file.write_all(data)?;
        self.size += data.len() as u64;
        Ok(())
    }
    pub fn read(&mut self) -> Result<String> {
        self.file
            .seek(SeekFrom::Start(self.size.saturating_sub(1 << 20)))?;
        let mut data = Vec::new();
        Read::by_ref(&mut self.file)
            .take(1 << 20)
            .read_to_end(&mut data)?;
        Ok(String::from_utf8_lossy(&data).into_owned())
    }
}

pub struct Managed {
    pub pid: i32,
    identity: String,
    exited: Arc<AtomicBool>,
}
pub struct Lifecycle {
    pub root: PathBuf,
    pub installation: Installation,
    pub network: NetworkManager,
    pub core: Option<Managed>,
    pub logs: Arc<Mutex<BoundedLog>>,
    key: Zeroizing<String>,
}
impl Lifecycle {
    pub fn new(root: &Path, installation: Installation) -> Result<Self> {
        Ok(Self {
            root: root.to_owned(),
            installation,
            network: NetworkManager::new(root),
            core: None,
            logs: Arc::new(Mutex::new(BoundedLog::new(
                &root.join("core.log"),
                4 << 20,
            )?)),
            key: Zeroizing::new(String::new()),
        })
    }
    pub fn stop(&mut self, shared: &Service) -> Result<()> {
        let Some(core) = &self.core else {
            return Ok(());
        };
        stop_pid(core.pid, &core.identity, Duration::from_secs(6))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !core.exited.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        ensure!(
            core.exited.load(Ordering::Acquire),
            "managed core did not exit"
        );
        self.core = None;
        self.key = Zeroizing::new(String::new());
        shared.running.store(false, Ordering::Release);
        files::remove_if_exists(&self.root.join("process.json"))?;
        Ok(())
    }
    pub fn start(
        &mut self,
        shared: &Arc<Service>,
        key: &str,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        ensure!(self.core.is_none(), "core already running");
        let core = self.root.join("mihomomo");
        ensure!(
            files::file_hash(&core)? == self.installation.core_hash,
            "installed core hash changed; authorize installation again"
        );
        let work = self.root.join("data");
        crate::dirfd::ProtectedDir::open(&work)?;
        let socket = work.join("core.sock");
        if let Ok(info) = fs::symlink_metadata(&socket) {
            use std::os::unix::fs::FileTypeExt;
            ensure!(info.file_type().is_socket(), "unexpected core socket");
            fs::remove_file(&socket)?;
        }
        let mut cmd = install::command(&core);
        cmd.args(["--momo-managed", "-d"])
            .arg(&work)
            .arg("-f")
            .arg(work.join("config.yaml"))
            .arg("-ext-ctl-unix")
            .arg(&socket)
            .env("HOME", &work)
            .current_dir(&work)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !key.is_empty() {
            cmd.env("CLASH_AGE_SECRET_KEY", key);
        }
        let mut child = cmd.spawn()?;
        let pid = child.id() as i32;
        let identity = match native::process_identity(pid) {
            Ok(identity) => identity,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        if let Err(e) = files::write_json(
            &self.root.join("process.json"),
            &ProcessRecord {
                pid,
                identity: identity.clone(),
            },
        ) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        let mut stdout = child.stdout.take().context("missing core stdout")?;
        let mut stderr = child.stderr.take().context("missing core stderr")?;
        for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFL);
                libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }
        let exited = Arc::new(AtomicBool::new(false));
        let done = exited.clone();
        let logs = self.logs.clone();
        let weak = Arc::downgrade(shared);
        let owned_child = Arc::new(Mutex::new(Some(child)));
        let thread_child = owned_child.clone();
        let spawned = thread::Builder::new()
            .name("momo-core-output".into())
            .spawn(move || {
                let mut fds = [
                    libc::pollfd {
                        fd: stdout.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                    libc::pollfd {
                        fd: stderr.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                ];
                let mut buffer = [0u8; 65536];
                while fds.iter().any(|fd| fd.fd >= 0) {
                    let count = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
                    if count < 0 {
                        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
                        {
                            continue;
                        }
                        break;
                    }
                    for (index, fd) in fds.iter_mut().enumerate() {
                        if fd.fd < 0 || fd.revents == 0 {
                            continue;
                        }
                        let reader: &mut dyn Read =
                            if index == 0 { &mut stdout } else { &mut stderr };
                        loop {
                            match reader.read(&mut buffer) {
                                Ok(0) => {
                                    fd.fd = -1;
                                    break;
                                }
                                Ok(count) => {
                                    if let Ok(mut log) = logs.lock() {
                                        let _ = log.write(&buffer[..count]);
                                    }
                                }
                                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                                Err(_) => {
                                    fd.fd = -1;
                                    break;
                                }
                            }
                        }
                    }
                }
                if let Ok(mut owned) = thread_child.lock()
                    && let Some(mut child) = owned.take()
                {
                    let _ = child.wait();
                }
                done.store(true, Ordering::Release);
                if let Some(shared) = weak.upgrade()
                    && let Ok(mut life) = shared.lifecycle.lock()
                    && life.core.as_ref().is_some_and(|core| core.pid == pid)
                {
                    shared.running.store(false, Ordering::Release);
                    life.core = None;
                    life.key = Zeroizing::new(String::new());
                    let _ = files::remove_if_exists(&life.root.join("process.json"));
                    let _ = life.network.restore();
                }
            });
        if let Err(error) = spawned {
            if let Ok(mut owned) = owned_child.lock()
                && let Some(mut child) = owned.take()
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = files::remove_if_exists(&self.root.join("process.json"));
            return Err(error.into());
        }
        self.core = Some(Managed {
            pid,
            identity,
            exited,
        });
        self.key = Zeroizing::new(key.to_owned());
        shared.running.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if cancelled.load(Ordering::Relaxed) {
                self.stop(shared)?;
                bail!("snapshot cancelled");
            }
            if self
                .core
                .as_ref()
                .is_some_and(|c| c.exited.load(Ordering::Acquire))
            {
                self.stop(shared)?;
                bail!("managed core exited during startup");
            }
            if core_request(
                &socket,
                "GET",
                "/version",
                None,
                Duration::from_millis(300),
                cancelled,
            )
            .is_ok_and(|status| status == 200)
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.stop(shared)?;
        bail!("managed core did not become ready")
    }
    pub fn snapshot(
        &mut self,
        shared: &Arc<Service>,
        input: &mut Snapshot,
        start: bool,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        ensure!(
            self.core.is_some() != start,
            if start {
                "core already running"
            } else {
                "core is not running"
            }
        );
        let mut transaction = input.stage(&self.root, cancelled)?;
        let work = self.root.join("data");
        let core = self.root.join("mihomomo");
        ensure!(
            files::file_hash(&core)? == self.installation.core_hash,
            "installed core hash changed; authorize installation again"
        );
        let mut cmd = install::command(&core);
        cmd.args(["--momo-managed", "-t", "-d"])
            .arg(&work)
            .arg("-f")
            .arg(work.join("config.yaml"))
            .arg("-ext-ctl-unix")
            .arg(work.join("core.sock"))
            .env("HOME", &work);
        if !input.key.is_empty() {
            cmd.env("CLASH_AGE_SECRET_KEY", &*input.key);
        }
        install::run_quiet(cmd, Duration::from_secs(30), cancelled)
            .map_err(|_| anyhow::anyhow!("managed core rejected configuration snapshot"))?;
        let result = if start {
            self.start(shared, &input.key, cancelled)
        } else if *input.key != *self.key {
            let previous = Zeroizing::new(self.key.to_string());
            let updated = self
                .stop(shared)
                .and_then(|_| self.start(shared, &input.key, cancelled));
            if let Err(error) = updated {
                transaction.rollback()?;
                self.start(shared, &previous, cancelled)
                    .context("cannot resume previous managed core")?;
                return Err(error);
            }
            Ok(())
        } else {
            let body = serde_json::to_vec(&serde_json::json!({"path":work.join("config.yaml")}))?;
            let status = core_request(
                &work.join("core.sock"),
                "PUT",
                "/configs?force=true",
                Some(&body),
                Duration::from_secs(30),
                cancelled,
            )?;
            ensure!(status < 300, "core rejected configuration reload");
            Ok(())
        };
        result?;
        transaction.commit()?;
        files::atomic_write(&self.root.join("migrated"), b"1", 0o600)?;
        Ok(())
    }
}

fn core_request(
    socket: &Path,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<u16> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(timeout.min(Duration::from_millis(100))))?;
    stream.set_write_timeout(Some(timeout))?;
    let body = body.unwrap_or_default();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: core\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    let deadline = Instant::now() + timeout;
    while !header.ends_with(b"\r\n\r\n") {
        ensure!(
            !cancelled.load(Ordering::Acquire) && Instant::now() < deadline,
            "core request cancelled or timed out"
        );
        ensure!(header.len() < 16384, "core response headers exceed limit");
        match stream.read_exact(&mut byte) {
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(e) => return Err(e.into()),
        }
        header.push(byte[0]);
    }
    let status = std::str::from_utf8(&header)?
        .split_whitespace()
        .nth(1)
        .context("invalid core response")?
        .parse()?;
    Ok(status)
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
