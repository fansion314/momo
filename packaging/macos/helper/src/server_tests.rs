use super::*;
use base64::Engine;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    task::JoinHandle,
};

#[tokio::test(flavor = "current_thread")]
async fn model_status_and_requested_resource_exports_use_protected_files() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    let token = harness.session().await;
    let mut model = b"tree".to_vec();
    model.extend_from_slice(&[b' '; 160]);
    model.extend_from_slice(b"[/target_enhance]\n");
    files::atomic_write(&harness.root.path().join("data/Model.bin"), &model, 0o600).unwrap();
    let (status, bytes) = harness
        .request("GET", "/v1/core/model", Some(&token), None, b"")
        .await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["state"], "ready");
    assert_eq!(value["size"], model.len());
    let (status, bytes) = harness
        .request(
            "POST",
            "/v1/core/resources",
            Some(&token),
            None,
            br#"["Model.bin"]"#,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["files"][0]["path"], "Model.bin");
    assert_eq!(value["files"][0]["data"], STANDARD.encode(model));
    let (status, _) = harness
        .request(
            "POST",
            "/v1/core/resources",
            Some(&token),
            None,
            br#"["../installation.json"]"#,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

struct Harness {
    root: tempfile::TempDir,
    service: Arc<Service>,
    listener: JoinHandle<()>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.service.shutdown.cancel();
        self.listener.abort();
    }
}
impl Harness {
    async fn new() -> Option<Self> {
        if unsafe { libc::geteuid() } != 0 {
            return None;
        }
        let parent = ["/root", "/var/lib", "/Library/Application Support"]
            .into_iter()
            .find(|p| files::protected_ancestors(Path::new(p)).is_ok())?;
        let root = tempfile::Builder::new()
            .prefix("momo-http-test-")
            .tempdir_in(parent)
            .ok()?;
        files::mkdir_protected(&root.path().join("data")).unwrap();
        let service = Service::new(
            root.path(),
            Installation {
                uid: 501,
                helper_hash: String::new(),
                core_hash: String::new(),
                core_version: "1.19.33".into(),
            },
        )
        .unwrap();
        let listener = UnixListener::bind(root.path().join("test.sock")).unwrap();
        let shared = service.clone();
        let listener = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let shared = shared.clone();
                tokio::spawn(async move {
                    let handler = service_fn(move |request| {
                        let shared = shared.clone();
                        async move { Ok::<_, Infallible>(shared.handle(request).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), handler)
                        .await;
                });
            }
        });
        Some(Self {
            root,
            service,
            listener,
        })
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        origin: Option<&str>,
        data: &[u8],
    ) -> (StatusCode, Vec<u8>) {
        let stream = UnixStream::connect(self.root.path().join("test.sock"))
            .await
            .unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Host", "helper")
            .header("Content-Type", "application/json");
        if let Some(token) = token {
            request = request.header("X-Momo-Session", token);
        }
        if let Some(origin) = origin {
            request = request.header("Origin", origin);
        }
        let response = sender
            .send_request(
                request
                    .body(Full::new(Bytes::copy_from_slice(data)))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, bytes)
    }
    async fn session(&self) -> String {
        let (status, bytes) = self.request("POST", "/v1/session", None, None, b"{}").await;
        assert_eq!(status, StatusCode::OK);
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn rejected_small_requests_accept_split_header_and_body_writes() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    let token = harness.session().await;
    for (path, extra, expected) in [
        ("/v1/core/start", String::new(), "401"),
        (
            "/core/restart",
            format!("X-Momo-Session: {token}\r\n"),
            "403",
        ),
        (
            "/v1/session",
            "Origin: http://evil.invalid\r\n".into(),
            "403",
        ),
    ] {
        let mut stream = UnixStream::connect(harness.root.path().join("test.sock"))
            .await
            .unwrap();
        let header = format!(
            "POST {path} HTTP/1.1\r\nHost: helper\r\n{extra}Content-Length: 2\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        let mut byte = [0u8; 1];
        assert!(
            tokio::time::timeout(Duration::from_millis(30), stream.read(&mut byte))
                .await
                .is_err()
        );
        stream.write_all(b"{}").await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(
            String::from_utf8(response)
                .unwrap()
                .starts_with(&format!("HTTP/1.1 {expected}"))
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn rejected_slow_or_large_bodies_do_not_hold_connections_open() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    for length in [2, 65537] {
        let mut stream = UnixStream::connect(harness.root.path().join("test.sock"))
            .await
            .unwrap();
        let header = format!(
            "POST /v1/core/start HTTP/1.1\r\nHost: helper\r\nContent-Length: {length}\r\n\r\n"
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 401"));
        assert!(response.to_ascii_lowercase().contains("connection: close"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn real_http_session_origin_and_token_boundaries() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    assert_eq!(
        harness
            .request(
                "POST",
                "/v1/session",
                None,
                Some("http://evil.invalid"),
                b"{}"
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let token = harness.session().await;
    assert_eq!(token.len(), 64);
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(
        harness
            .request("POST", "/v1/session", None, None, b"{}")
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        harness
            .request("POST", "/v1/lease", Some("wrong"), None, b"{}")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        harness
            .request(
                "POST",
                "/v1/lease",
                Some(&token),
                Some("http://evil.invalid"),
                b"{}"
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    {
        let mut session = harness.service.session.lock().unwrap();
        session.lease = Instant::now() - Duration::from_secs(11);
    }
    let next = harness.session().await;
    assert_ne!(token, next);
    assert_eq!(
        harness
            .request("POST", "/v1/lease", Some(&token), None, b"{}")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        harness
            .request("POST", "/v1/lease", Some(&next), None, b"{}")
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test(flavor = "current_thread")]
async fn real_http_lease_stays_independent_of_lifecycle_lock() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    let token = harness.session().await;
    let (ready, started) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let shared = harness.service.clone();
    let holder = tokio::task::spawn_blocking(move || {
        let _guard = shared.lifecycle.lock().unwrap();
        let _ = ready.send(());
        let _ = released.recv_timeout(Duration::from_secs(3));
    });
    started.await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        harness.request("POST", "/v1/lease", Some(&token), None, b"{}"),
    )
    .await;
    release.send(()).unwrap();
    holder.await.unwrap();
    assert_eq!(
        result.expect("lease was blocked by lifecycle lock").0,
        StatusCode::OK
    );
}

#[tokio::test(flavor = "current_thread")]
async fn rejected_snapshot_preserves_the_live_session() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    let token = harness.session().await;
    assert_eq!(
        harness
            .request(
                "POST",
                "/v1/core/start",
                Some(&token),
                None,
                b"{\"config\":\"x\",\"unknown\":true}"
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        harness
            .request("POST", "/v1/lease", Some(&token), None, b"{}")
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test(flavor = "current_thread")]
async fn expiry_of_previous_generation_preserves_new_session() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    let _token = harness.session().await;
    let journal = harness.root.path().join("network.json");
    let marker = br#"{"entries":null}"#;
    files::atomic_write(&journal, marker, 0o600).unwrap();
    let (ready, started) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let shared = harness.service.clone();
    let holder = tokio::task::spawn_blocking(move || {
        let _guard = shared.lifecycle.lock().unwrap();
        let _ = ready.send(());
        let _ = released.recv_timeout(Duration::from_secs(3));
    });
    started.await.unwrap();
    harness.service.session.lock().unwrap().lease = Instant::now() - Duration::from_secs(11);
    let expiry = tokio::spawn(harness.service.clone().expire());
    tokio::time::timeout(Duration::from_secs(2), async {
        while !harness.service.session.lock().unwrap().token.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    {
        let mut session = harness.service.session.lock().unwrap();
        session.generation += 1;
        session.token = Zeroizing::new("b".repeat(64));
        session.cancelled = Arc::new(AtomicBool::new(false));
        session.lease = Instant::now();
    }
    release.send(()).unwrap();
    holder.await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(std::fs::read(&journal).unwrap(), marker);
    assert_eq!(
        harness
            .request("POST", "/v1/lease", Some(&"b".repeat(64)), None, b"{}")
            .await
            .0,
        StatusCode::OK
    );
    expiry.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn stalled_snapshot_is_cancelled_when_lease_expires() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    let token = harness.session().await;
    let mut stream = UnixStream::connect(harness.root.path().join("test.sock"))
        .await
        .unwrap();
    stream.write_all(format!("POST /v1/core/start HTTP/1.1\r\nHost: helper\r\nConnection: close\r\nContent-Type: application/json\r\nX-Momo-Session: {token}\r\nContent-Length: 65536\r\n\r\n{{\"config\":\"mode: direct\\n\",\"files\":[").as_bytes()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while harness.service.lifecycle.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("snapshot never acquired lifecycle lock");
    harness.service.session.lock().unwrap().lease = Instant::now() - Duration::from_secs(11);
    let expiry = tokio::spawn(harness.service.clone().expire());
    let mut response = [0u8; 512];
    let received = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut response))
        .await
        .expect("stalled snapshot was not interrupted")
        .unwrap();
    assert!(
        std::str::from_utf8(&response[..received])
            .unwrap()
            .starts_with("HTTP/1.1 400")
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while harness.service.lifecycle.try_lock().is_err() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("expiry did not release lifecycle lock");
    assert!(harness.service.session.lock().unwrap().token.is_empty());
    expiry.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn blocked_export_cancellation_releases_lifecycle_lock() {
    let Some(harness) = Harness::new().await else {
        return;
    };
    let (sender, receiver) = mpsc::channel(1);
    sender
        .try_send(Ok(Bytes::from_static(b"already full")))
        .unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let shared = harness.service.clone();
    let operation_cancelled = cancelled.clone();
    let (ready, started) = oneshot::channel();
    let (done, finished) = oneshot::channel();
    let task = tokio::task::spawn_blocking(move || {
        let _guard = shared.lifecycle.lock().unwrap();
        let mut writer = ChannelWriter {
            sender,
            cancelled: operation_cancelled,
        };
        let _ = ready.send(());
        let result = writer.write(b"cannot enter full queue");
        let _ = done.send(result.is_err());
    });
    started.await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancelled.store(true, Ordering::Release);
    let stopped = tokio::time::timeout(Duration::from_secs(1), finished).await;
    drop(receiver);
    task.await.unwrap();
    assert!(
        stopped
            .expect("cancelled export remained blocked by a slow client")
            .unwrap()
    );
    assert!(harness.service.lifecycle.try_lock().is_ok());
}
