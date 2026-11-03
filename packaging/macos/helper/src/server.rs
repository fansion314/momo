use crate::{
    HELPER_PATH, Installation, ROOT, SOCKET, SOCKET_DIR, files, install, native,
    process::{Lifecycle, recover_owned_process},
    snapshot,
};
use anyhow::{Context, Result, ensure};
use base64::{engine::general_purpose::STANDARD, write::EncoderWriter};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response, StatusCode,
    body::{Body, Frame, Incoming},
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    fs::{self, File},
    io::{self, Read, Write},
    os::unix::{fs::PermissionsExt, io::AsRawFd},
    path::Path,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context as TaskContext, Poll},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{
    net::{UnixListener, UnixStream},
    sync::{Notify, Semaphore, mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type HttpBody = UnsyncBoxBody<Bytes, BoxError>;
type HttpResponse = Response<HttpBody>;
type ExportState<'a> = (std::sync::MutexGuard<'a, Lifecycle>, Vec<(String, File)>);

struct Session {
    token: Zeroizing<String>,
    lease: Instant,
    generation: u64,
    cancelled: Arc<AtomicBool>,
}
pub struct Service {
    root: std::path::PathBuf,
    pub lifecycle: Mutex<Lifecycle>,
    session: Mutex<Session>,
    pub running: AtomicBool,
    changed: Notify,
    shutdown: CancellationToken,
    streams: Arc<Semaphore>,
}

fn body(data: impl Into<Bytes>) -> HttpBody {
    Full::new(data.into())
        .map_err(|never: Infallible| match never {})
        .boxed_unsync()
}
fn response(status: StatusCode, data: impl Into<Bytes>) -> HttpResponse {
    Response::builder()
        .status(status)
        .body(body(data))
        .expect("fixed HTTP response")
}
fn json(value: serde_json::Value) -> HttpResponse {
    let mut response = response(
        StatusCode::OK,
        serde_json::to_vec(&value).expect("serializable response"),
    );
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}
fn failure(status: StatusCode, message: &str) -> HttpResponse {
    response(status, message.to_owned())
}

async fn drain_small_request(incoming: &mut Incoming) -> bool {
    const LIMIT: u64 = 65536;
    if incoming.size_hint().upper().is_none_or(|size| size > LIMIT) {
        return false;
    }
    // Small HTTP clients can send headers and the body in separate writes. An
    // immediate rejection must not close their socket before that body arrives.
    tokio::time::timeout(
        Duration::from_millis(500),
        http_body_util::Limited::new(incoming, LIMIT as usize).collect(),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn rejected(
    mut request: Request<Incoming>,
    status: StatusCode,
    message: &str,
) -> HttpResponse {
    let drained = drain_small_request(request.body_mut()).await;
    let mut response = failure(status, message);
    if !drained {
        response.headers_mut().insert(
            hyper::header::CONNECTION,
            hyper::header::HeaderValue::from_static("close"),
        );
    }
    response
}
fn locked<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| anyhow::anyhow!("service state unavailable"))
}

impl Service {
    pub(crate) fn new(root: &Path, installation: Installation) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            root: root.to_owned(),
            lifecycle: Mutex::new(Lifecycle::new(root, installation)?),
            session: Mutex::new(Session {
                token: Zeroizing::new(String::new()),
                lease: Instant::now(),
                generation: 0,
                cancelled: Arc::new(AtomicBool::new(false)),
            }),
            running: AtomicBool::new(false),
            changed: Notify::new(),
            shutdown: CancellationToken::new(),
            streams: Arc::new(Semaphore::new(16)),
        }))
    }
    fn authorized(&self, token: &str) -> Result<(u64, Arc<AtomicBool>)> {
        let session = locked(&self.session)?;
        ensure!(
            !token.is_empty()
                && bool::from(token.as_bytes().ct_eq(session.token.as_bytes()))
                && session.lease.elapsed() <= Duration::from_secs(10),
            "session required"
        );
        ensure!(
            !session.cancelled.load(Ordering::Acquire),
            "session required"
        );
        Ok((session.generation, session.cancelled.clone()))
    }
    async fn expire(self: Arc<Self>) {
        loop {
            let notified = self.changed.notified();
            let deadline = match self.session.lock() {
                Ok(s) if !s.token.is_empty() => Some(s.lease + Duration::from_secs(10)),
                _ => None,
            };
            match deadline {
                None => tokio::select! {_=notified=>{},_=self.shutdown.cancelled()=>return},
                Some(deadline) => {
                    tokio::select! {_=notified=>continue,_=self.shutdown.cancelled()=>return,_=tokio::time::sleep_until(deadline.into())=>{}}
                }
            }
            let expired = {
                let Ok(mut session) = self.session.lock() else {
                    return;
                };
                if session.token.is_empty() || session.lease.elapsed() < Duration::from_secs(10) {
                    None
                } else {
                    session.token = Zeroizing::new(String::new());
                    session.cancelled.store(true, Ordering::Release);
                    Some(session.generation)
                }
            };
            if let Some(generation) = expired {
                let shared = self.clone();
                let _ = tokio::task::spawn_blocking(move || -> Result<()> {
                    let mut life = locked(&shared.lifecycle)?;
                    if locked(&shared.session)?.generation == generation {
                        life.stop(&shared)?;
                        life.network.restore()?;
                    }
                    Ok(())
                })
                .await;
            }
        }
    }
    async fn handle(self: Arc<Self>, mut request: Request<Incoming>) -> HttpResponse {
        if request.headers().contains_key("origin") {
            return rejected(
                request,
                StatusCode::FORBIDDEN,
                "browser origins are forbidden",
            )
            .await;
        }
        let path = request.uri().path().to_owned();
        let method = request.method().as_str().to_owned();
        let token = request
            .headers()
            .get("X-Momo-Session")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        if method == "POST"
            && (path == "/v1/session" || path == "/v1/lease")
            && !drain_small_request(request.body_mut()).await
        {
            let mut response = failure(StatusCode::BAD_REQUEST, "invalid or oversized request");
            response.headers_mut().insert(
                hyper::header::CONNECTION,
                hyper::header::HeaderValue::from_static("close"),
            );
            return response;
        }
        if method == "POST" && path == "/v1/lease" {
            let Ok(mut session) = self.session.lock() else {
                return failure(StatusCode::SERVICE_UNAVAILABLE, "service state unavailable");
            };
            if token.is_empty()
                || !bool::from(token.as_bytes().ct_eq(session.token.as_bytes()))
                || session.lease.elapsed() > Duration::from_secs(10)
                || session.cancelled.load(Ordering::Acquire)
            {
                return failure(StatusCode::UNAUTHORIZED, "session required");
            }
            session.lease = Instant::now();
            self.changed.notify_one();
            return json(
                serde_json::json!({"ok":true,"running":self.running.load(Ordering::Acquire)}),
            );
        }
        if method == "GET" && path == "/v1/status" {
            let shared = self.clone();
            return blocking_response(move||{
                let life=locked(&shared.lifecycle)?;let installation=&life.installation;
                Ok(json(serde_json::json!({"protocol":1,"helperVersion":"2","coreVersion":installation.core_version,"helperHash":installation.helper_hash,"coreHash":installation.core_hash,"running":shared.running.load(Ordering::Acquire),"pid":life.core.as_ref().map_or(0,|c|c.pid),"workDir":life.root.join("data"),"uid":installation.uid,"dataMigrated":life.root.join("migrated").is_file()})))
            }).await;
        }
        if method == "POST" && path == "/v1/session" {
            let shared = self.clone();
            return blocking_response(move || {
                let mut life = locked(&shared.lifecycle)?;
                {
                    let session = locked(&shared.session)?;
                    if !session.token.is_empty()
                        && !session.cancelled.load(Ordering::Acquire)
                        && session.lease.elapsed() <= Duration::from_secs(10)
                    {
                        return Ok(failure(
                            StatusCode::CONFLICT,
                            "an application session is already active",
                        ));
                    }
                    session.cancelled.store(true, Ordering::Release);
                }
                life.stop(&shared)?;
                life.network.restore()?;
                let mut random = [0u8; 32];
                getrandom::fill(&mut random)
                    .map_err(|_| anyhow::anyhow!("cannot create session"))?;
                let token = random
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                let mut session = locked(&shared.session)?;
                session.token = Zeroizing::new(token.clone());
                session.generation = session.generation.wrapping_add(1);
                session.cancelled = Arc::new(AtomicBool::new(false));
                session.lease = Instant::now();
                shared.changed.notify_one();
                Ok(json(serde_json::json!({"token":token})))
            })
            .await;
        }
        let (generation, cancelled) = match self.authorized(&token) {
            Ok(auth) => auth,
            Err(_) => return rejected(request, StatusCode::UNAUTHORIZED, "session required").await,
        };
        if path.starts_with("/core/") {
            if !allowed_core_route(&method, path.strip_prefix("/core").unwrap_or_default()) {
                return rejected(request, StatusCode::FORBIDDEN, "operation forbidden").await;
            }
            if !self.running.load(Ordering::Acquire) {
                return rejected(
                    request,
                    StatusCode::SERVICE_UNAVAILABLE,
                    "managed core is not running",
                )
                .await;
            }
            let permit = match self.streams.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    return rejected(
                        request,
                        StatusCode::TOO_MANY_REQUESTS,
                        "too many active core streams",
                    )
                    .await;
                }
            };
            return match proxy(
                request,
                &self.root.join("data/core.sock"),
                permit,
                self.shutdown.clone(),
            )
            .await
            {
                Ok(response) => response,
                Err(_) => failure(StatusCode::BAD_GATEWAY, "managed core unavailable"),
            };
        }
        if method == "POST" && (path == "/v1/core/start" || path == "/v1/core/config") {
            return self
                .upload_snapshot(request, generation, cancelled, path == "/v1/core/start")
                .await;
        }
        if method == "GET" && path == "/v1/core/state" {
            return self.export(generation, cancelled).await;
        }
        let bytes = if method == "POST" {
            match small_body(request.into_body(), 65536, &cancelled).await {
                Ok(bytes) => bytes,
                Err(_) => return failure(StatusCode::BAD_REQUEST, "invalid or oversized request"),
            }
        } else {
            Vec::new()
        };
        let shared = self.clone();
        blocking_response(move || {
            let mut life = locked(&shared.lifecycle)?;
            ensure!(
                shared.authorized(&token)?.0 == generation && !cancelled.load(Ordering::Acquire),
                "session required"
            );
            match (method.as_str(), path.as_str()) {
                ("POST", "/v1/core/stop") => {
                    life.stop(&shared)?;
                    life.network.restore()?;
                }
                ("GET", "/v1/core/logs") => {
                    return Ok(json(
                        serde_json::json!({"logs":locked(&life.logs)?.read()?}),
                    ));
                }
                ("POST", "/v1/network/proxy") => {
                    life.network.proxy(serde_json::from_slice(&bytes)?)?
                }
                ("POST", "/v1/network/dns") => life.network.dns(serde_json::from_slice(&bytes)?)?,
                ("GET", "/v1/network/status") => return Ok(json(life.network.status())),
                _ => return Ok(failure(StatusCode::NOT_FOUND, "not found")),
            }
            Ok(json(serde_json::json!({"ok":true})))
        })
        .await
    }
    async fn upload_snapshot(
        self: Arc<Self>,
        request: Request<Incoming>,
        generation: u64,
        cancelled: Arc<AtomicBool>,
        start: bool,
    ) -> HttpResponse {
        if request
            .headers()
            .get(hyper::header::CONTENT_LENGTH)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse::<u64>().ok())
            .is_some_and(|length| length > 768 << 20)
        {
            return failure(StatusCode::PAYLOAD_TOO_LARGE, "snapshot exceeds limits");
        }
        let (sender, receiver) = mpsc::channel(2);
        let shared = self.clone();
        let parse_cancelled = cancelled.clone();
        let task = tokio::task::spawn_blocking(move || -> Result<()> {
            let mut life = locked(&shared.lifecycle)?;
            ensure!(
                locked(&shared.session)?.generation == generation
                    && !parse_cancelled.load(Ordering::Acquire),
                "session required"
            );
            let reader = ChannelReader {
                receiver,
                current: io::Cursor::new(Bytes::new()),
            };
            let mut snapshot = snapshot::parse(reader, &life.root, parse_cancelled.clone())?;
            ensure!(
                !parse_cancelled.load(Ordering::Acquire),
                "snapshot cancelled"
            );
            life.snapshot(&shared, &mut snapshot, start, &parse_cancelled)
        });
        let mut incoming = request.into_body();
        let mut total = 0u64;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        let transfer = async {
            while let Some(frame) = incoming.frame().await {
                let frame = frame?;
                if let Ok(bytes) = frame.into_data() {
                    total += bytes.len() as u64;
                    ensure!(total <= 768 << 20, "snapshot exceeds limits");
                    for part in bytes.chunks(65536) {
                        ensure!(!cancelled.load(Ordering::Acquire), "snapshot cancelled");
                        sender
                            .send(Bytes::copy_from_slice(part))
                            .await
                            .map_err(|_| anyhow::anyhow!("snapshot rejected"))?;
                    }
                }
            }
            Ok::<(), anyhow::Error>(())
        };
        let transfer = tokio::select! {result=tokio::time::timeout_at(deadline,transfer)=>result.map_err(|_|anyhow::anyhow!("snapshot timed out")).and_then(|r|r),_=self.shutdown.cancelled()=>Err(anyhow::anyhow!("service stopping")),_=wait_cancelled(cancelled.clone())=>Err(anyhow::anyhow!("snapshot cancelled"))};
        drop(sender);
        if transfer.is_err() {
            cancelled.store(true, Ordering::Release);
        }
        let result = task.await.map_err(anyhow::Error::from).and_then(|r| r);
        if transfer.is_err() || result.is_err() {
            return failure(StatusCode::BAD_REQUEST, "snapshot rejected or cancelled");
        }
        json(serde_json::json!({"ok":true}))
    }
    async fn export(self: Arc<Self>, generation: u64, cancelled: Arc<AtomicBool>) -> HttpResponse {
        let (sender, receiver) = mpsc::channel(4);
        let (ready, prepared) = oneshot::channel();
        let shared = self.clone();
        tokio::task::spawn_blocking(move || {
            let prepare = || -> Result<ExportState<'_>> {
                let life = locked(&shared.lifecycle)?;
                ensure!(
                    locked(&shared.session)?.generation == generation
                        && !cancelled.load(Ordering::Acquire),
                    "session required"
                );
                ensure!(
                    life.core.is_none(),
                    "stop the managed core before exporting state"
                );
                files::protected_tree(&life.root.join("data"))?;
                let mut files = Vec::new();
                let mut total = 0;
                for name in [
                    "traffic-history.db",
                    "traffic-history.db-wal",
                    "traffic-history.db-shm",
                    "cache.db",
                    "cache.db-wal",
                    "cache.db-shm",
                ] {
                    let path = life.root.join("data").join(name);
                    if !path.try_exists()? {
                        continue;
                    }
                    let file = files::checked_open(&path)?;
                    total += file.metadata()?.len();
                    ensure!(total <= 512 << 20, "state export exceeds 512MiB");
                    files.push((name.to_owned(), file));
                }
                Ok((life, files))
            };
            match prepare() {
                Err(_) => {
                    let _ = ready.send(false);
                }
                Ok((_life, mut files)) => {
                    if ready.send(true).is_err() {
                        return;
                    }
                    let mut output = ChannelWriter { sender, cancelled };
                    let result = (|| -> Result<()> {
                        output.write_all(b"{\"files\":[")?;
                        for (index, (name, file)) in files.iter_mut().enumerate() {
                            if index > 0 {
                                output.write_all(b",")?;
                            }
                            write!(
                                output,
                                "{{\"path\":{},\"data\":\"",
                                serde_json::to_string(name)?
                            )?;
                            let mut encoder = EncoderWriter::new(&mut output, &STANDARD);
                            io::copy(file, &mut encoder)?;
                            encoder.finish()?;
                            drop(encoder);
                            output.write_all(b"\"}")?;
                        }
                        output.write_all(b"]}")?;
                        Ok(())
                    })();
                    if result.is_err() {
                        let _ = output
                            .sender
                            .try_send(Err(io::Error::other("state export interrupted")));
                    }
                }
            }
        });
        if prepared.await != Ok(true) {
            return failure(
                StatusCode::CONFLICT,
                "stop the managed core before exporting state",
            );
        }
        let mut response = Response::new(ChannelBody { receiver }.boxed_unsync());
        response.headers_mut().insert(
            hyper::header::CONTENT_TYPE,
            hyper::header::HeaderValue::from_static("application/json"),
        );
        response
    }
}

async fn blocking_response(
    task: impl FnOnce() -> Result<HttpResponse> + Send + 'static,
) -> HttpResponse {
    match tokio::task::spawn_blocking(task).await {
        Ok(Ok(response)) => response,
        _ => failure(StatusCode::BAD_REQUEST, "operation failed"),
    }
}
async fn wait_cancelled(cancelled: Arc<AtomicBool>) {
    while !cancelled.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn small_body(mut incoming: Incoming, max: usize, cancelled: &AtomicBool) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(frame) = tokio::time::timeout(Duration::from_secs(10), incoming.frame()).await? {
        ensure!(!cancelled.load(Ordering::Acquire), "request cancelled");
        if let Ok(data) = frame?.into_data() {
            ensure!(bytes.len() + data.len() <= max, "request too large");
            bytes.extend_from_slice(&data);
        }
    }
    Ok(bytes)
}

struct ChannelReader {
    receiver: mpsc::Receiver<Bytes>,
    current: io::Cursor<Bytes>,
}
impl Read for ChannelReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            let count = self.current.read(buffer)?;
            if count > 0 {
                return Ok(count);
            }
            match self.receiver.blocking_recv() {
                Some(bytes) => self.current = io::Cursor::new(bytes),
                None => return Ok(0),
            }
        }
    }
}
struct ChannelWriter {
    sender: mpsc::Sender<io::Result<Bytes>>,
    cancelled: Arc<AtomicBool>,
}
impl Write for ChannelWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(io::Error::other("export cancelled"));
        }
        let mut item = Ok(Bytes::copy_from_slice(buffer));
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err(io::Error::other("export cancelled or stalled"));
            }
            match self.sender.try_send(item) {
                Ok(()) => break,
                Err(mpsc::error::TrySendError::Full(returned)) => {
                    item = returned;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    return Err(io::Error::other("export disconnected"));
                }
            }
        }
        Ok(buffer.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct ChannelBody {
    receiver: mpsc::Receiver<io::Result<Bytes>>,
}

struct Activity {
    active: AtomicUsize,
    last: Mutex<Instant>,
    changed: Notify,
}
struct ActivityGuard(Arc<Activity>);
impl Drop for ActivityGuard {
    fn drop(&mut self) {
        if let Ok(mut last) = self.0.last.lock() {
            *last = Instant::now();
        }
        self.0.active.fetch_sub(1, Ordering::Release);
        self.0.changed.notify_one();
    }
}
struct TrackedBody {
    inner: HttpBody,
    _guard: ActivityGuard,
}
impl Body for TrackedBody {
    type Data = Bytes;
    type Error = BoxError;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}
async fn idle_timeout(activity: Arc<Activity>, duration: Duration) {
    loop {
        let changed = activity.changed.notified();
        if activity.active.load(Ordering::Acquire) > 0 {
            changed.await;
            continue;
        }
        let deadline = match activity.last.lock() {
            Ok(last) => *last + duration,
            Err(_) => return,
        };
        tokio::select! {_=changed=>{},_=tokio::time::sleep_until(deadline.into())=>{if activity.active.load(Ordering::Acquire)==0{return;}}}
    }
}
impl Body for ChannelBody {
    type Data = Bytes;
    type Error = BoxError;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        self.receiver
            .poll_recv(cx)
            .map(|item| item.map(|r| r.map(Frame::data).map_err(|e| Box::new(e) as BoxError)))
    }
}

pub fn allowed_core_route(method: &str, path: &str) -> bool {
    if path.contains(['%', '\\', '\0']) || path.contains("..") {
        return false;
    }
    match method {
        "GET" => [
            "/",
            "/version",
            "/configs",
            "/proxies",
            "/providers/proxies",
            "/providers/rules",
            "/rules",
            "/connections",
            "/traffic",
            "/logs",
            "/memory",
            "/dns/query",
            "/group",
            "/traffic-history",
            "/smart",
        ]
        .iter()
        .any(|base| path == *base || (*base != "/" && path.starts_with(&format!("{base}/")))),
        "PATCH" => path == "/configs",
        "DELETE" => path == "/connections" || path.starts_with("/connections/"),
        "PUT" => ["/proxies/", "/providers/proxies/", "/providers/rules/"]
            .iter()
            .any(|base| path.starts_with(base)),
        "POST" => {
            [
                "/configs/geo",
                "/cache/fakeip/flush",
                "/cache/dns/flush",
                "/connections",
            ]
            .contains(&path)
                || path.starts_with("/smart/")
        }
        _ => false,
    }
}

async fn proxy(
    mut request: Request<Incoming>,
    socket: &Path,
    permit: tokio::sync::OwnedSemaphorePermit,
    shutdown: CancellationToken,
) -> Result<HttpResponse> {
    let frontend = hyper::upgrade::on(&mut request);
    let stream =
        tokio::time::timeout(Duration::from_secs(5), UnixStream::connect(socket)).await??;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    let target = request
        .uri()
        .path_and_query()
        .context("invalid core URL")?
        .as_str()
        .strip_prefix("/core")
        .context("invalid core URL")?
        .to_owned();
    let mut outgoing = Request::builder().method(request.method()).uri(target);
    for (name, value) in request.headers() {
        if !["x-momo-session", "authorization", "cookie", "host"].contains(&name.as_str()) {
            outgoing = outgoing.header(name, value);
        }
    }
    outgoing = outgoing.header(hyper::header::HOST, "core");
    let mut response = tokio::time::timeout(
        Duration::from_secs(15),
        sender.send_request(outgoing.body(request.into_body())?),
    )
    .await??;
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let backend = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            let _permit = permit;
            if let (Ok(front), Ok(back)) = tokio::join!(frontend, backend) {
                let mut front = TokioIo::new(front);
                let mut back = TokioIo::new(back);
                let copy = tokio::io::copy_bidirectional(&mut front, &mut back);
                tokio::select! {_=copy=>{},_=shutdown.cancelled()=>{}}
            }
        });
    }
    Ok(response.map(|body| body.map_err(|e| Box::new(e) as BoxError).boxed_unsync()))
}

pub async fn print_status() -> Result<()> {
    let stream =
        tokio::time::timeout(Duration::from_secs(2), UnixStream::connect(SOCKET)).await??;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        sender.send_request(
            Request::builder()
                .uri("http://helper/v1/status")
                .body(Full::new(Bytes::new()))?,
        ),
    )
    .await??;
    ensure!(
        response.status() == StatusCode::OK,
        "helper status unavailable"
    );
    let data = http_body_util::Limited::new(response.into_body(), 16384)
        .collect()
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .to_bytes();
    io::stdout().write_all(&data)?;
    Ok(())
}

pub async fn serve() -> Result<()> {
    let root = Path::new(ROOT);
    files::protected_tree(root)?;
    let installation: Installation = files::read_json(&root.join("installation.json"))?;
    ensure!(installation.uid > 0, "invalid installed UID");
    ensure!(
        files::file_hash(Path::new(HELPER_PATH))? == installation.helper_hash,
        "installed helper hash mismatch; authorize installation again"
    );
    ensure!(
        files::file_hash(&root.join("mihomomo"))? == installation.core_hash,
        "installed core hash mismatch; authorize installation again"
    );
    recover_owned_process(root)?;
    let shared = Service::new(root, installation.clone())?;
    locked(&shared.lifecycle)?.network.restore()?;
    files::mkdir_protected(Path::new(SOCKET_DIR))?;
    fs::set_permissions(SOCKET_DIR, fs::Permissions::from_mode(0o711))?;
    install::remove_socket(Some(installation.uid))?;
    let listener = UnixListener::bind(SOCKET)?;
    let socket = std::ffi::CString::new(SOCKET)?;
    ensure!(
        unsafe { libc::chown(socket.as_ptr(), installation.uid, u32::MAX) } == 0,
        "cannot set socket ownership"
    );
    fs::set_permissions(SOCKET, fs::Permissions::from_mode(0o600))?;
    tokio::spawn(shared.clone().expire());
    let connections = Arc::new(Semaphore::new(32));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    loop {
        let accepted = tokio::select! {accepted=listener.accept()=>accepted,_=terminate.recv()=>break,_=interrupt.recv()=>break};
        let (stream, _) = accepted?;
        if native::peer_uid(stream.as_raw_fd()).ok() != Some(installation.uid) {
            continue;
        }
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            continue;
        };
        let service = shared.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(5))
                .max_headers(64)
                .max_buf_size(32768);
            let request_service = service.clone();
            let activity = Arc::new(Activity {
                active: AtomicUsize::new(0),
                last: Mutex::new(Instant::now()),
                changed: Notify::new(),
            });
            let request_activity = activity.clone();
            let connection = builder
                .serve_connection(
                    TokioIo::new(stream),
                    service_fn(move |request| {
                        let service = request_service.clone();
                        let activity = request_activity.clone();
                        activity.active.fetch_add(1, Ordering::AcqRel);
                        activity.changed.notify_one();
                        let guard = ActivityGuard(activity);
                        async move {
                            Ok::<_, Infallible>(service.handle(request).await.map(|inner| {
                                TrackedBody {
                                    inner,
                                    _guard: guard,
                                }
                                .boxed_unsync()
                            }))
                        }
                    }),
                )
                .with_upgrades();
            tokio::select! {_=connection=>{},_=service.shutdown.cancelled()=>{},_=idle_timeout(activity,Duration::from_secs(15))=>{}}
        });
    }
    shared.shutdown.cancel();
    if let Ok(session) = shared.session.lock() {
        session.cancelled.store(true, Ordering::Release);
    }
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut life = locked(&shared.lifecycle)?;
        life.stop(&shared)?;
        life.network.restore()
    })
    .await??;
    Ok(())
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "current_thread")]
    async fn idle_connections_expire_but_live_response_bodies_do_not() {
        let activity = Arc::new(Activity {
            active: AtomicUsize::new(1),
            last: Mutex::new(Instant::now()),
            changed: Notify::new(),
        });
        let watcher = tokio::spawn(idle_timeout(activity.clone(), Duration::from_millis(30)));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(!watcher.is_finished());
        drop(ActivityGuard(activity));
        tokio::time::timeout(Duration::from_millis(300), watcher)
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn core_route_boundaries() {
        for (method, path) in [
            ("POST", "/restart"),
            ("POST", "/upgrade"),
            ("PUT", "/configs"),
            ("GET", "/proxies/../../etc/passwd"),
            ("GET", "/providers/proxies/%2fetc"),
            ("GET", "/unknown"),
        ] {
            assert!(!allowed_core_route(method, path));
        }
        for (method, path) in [
            ("GET", "/version"),
            ("GET", "/traffic"),
            ("GET", "/traffic-history/status"),
            ("PATCH", "/configs"),
            ("PUT", "/proxies/group"),
            ("DELETE", "/connections/id"),
        ] {
            assert!(allowed_core_route(method, path));
        }
    }
}
