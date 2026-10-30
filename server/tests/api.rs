use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tizi_server::{App, next_boundary, router, settlement_day};
use tower::ServiceExt;
use uuid::Uuid;
struct Fixture {
    app: App,
    _dir: tempfile::TempDir,
    key: SigningKey,
    id: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(&dir.path().join("test.db"), vec![42; 32]).unwrap();
        Self {
            app,
            _dir: dir,
            key: SigningKey::from_bytes(&[7; 32]),
            id: Uuid::new_v4().to_string(),
        }
    }
    async fn request(&self, path: &str, value: Value, signed: bool) -> (StatusCode, Value) {
        let bytes = if value.is_null() {
            vec![]
        } else {
            serde_json::to_vec(&value).unwrap()
        };
        let method = if value.is_null() { "GET" } else { "POST" };
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if signed {
            let stamp = chrono::Utc::now().timestamp().to_string();
            let nonce = Uuid::new_v4().to_string();
            let input = format!(
                "TIZI1\n{method}\n{path}\n{}\n{stamp}\n{nonce}\n{}",
                self.id,
                hex::encode(Sha256::digest(&bytes))
            );
            request = request
                .header("X-Tizi-Device", &self.id)
                .header("X-Tizi-Timestamp", stamp)
                .header("X-Tizi-Nonce", nonce)
                .header(
                    "X-Tizi-Signature",
                    STANDARD.encode(self.key.sign(input.as_bytes()).to_bytes()),
                );
        }
        let response = router(self.app.clone())
            .oneshot(request.body(Body::from(bytes)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        if path == "/v1/subscription" && status == StatusCode::OK {
            assert!(!response.headers().contains_key("subscription-userinfo"));
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)})),
        )
    }
    async fn register(&self) {
        assert_eq!(
            self.request(
                "/v1/registration/request",
                json!({"email":"alice@example.com"}),
                false
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            self.app
                .db
                .lock()
                .unwrap()
                .query_row("SELECT count(*) FROM outbox", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        self.app.approve("alice@example.com").unwrap();
        let code: String = self
            .app
            .db
            .lock()
            .unwrap()
            .query_row("SELECT code FROM outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(self.request("/v1/registration/complete",json!({"email":"alice@example.com","code":code,"password":"a sufficiently long phrase"}),false).await.0,StatusCode::OK);
    }
    async fn login(&self) -> StatusCode {
        self.request("/v1/login",json!({"email":"alice@example.com","password":"a sufficiently long phrase","device_id":self.id,"device_name":"fixture","public_key":STANDARD.encode(self.key.verifying_key().to_bytes())}),true).await.0
    }
}
#[tokio::test]
async fn approvals_auth_reports_and_revocation() {
    let f = Fixture::new();
    assert_eq!(
        f.request("/v1/subscription", Value::Null, false).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(f.login().await, StatusCode::UNAUTHORIZED);
    f.register().await;
    assert_eq!(f.login().await, StatusCode::OK);
    let day = settlement_day(chrono::Utc::now().timestamp()).to_string();
    let report = json!({"sequence":1,"days":[{"day":day,"upload_bytes":100,"download_bytes":200}],"health":{"healthy":true}});
    assert_eq!(
        f.request("/v1/usage/report", report.clone(), true).await.0,
        StatusCode::OK
    );
    assert_eq!(
        f.request("/v1/usage/report", report, true).await.0,
        StatusCode::OK
    );
    let (status, view) = f.request("/v1/me/usage", Value::Null, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["days"][0]["download_bytes"], 200);
    assert_eq!(
        f.request(
            "/v1/usage/report",
            json!({"sequence":2,"days":[{"day":day,"upload_bytes":99,"download_bytes":200}]}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    f.app
        .db
        .lock()
        .unwrap()
        .execute("UPDATE devices SET revoked=1", [])
        .unwrap();
    assert_eq!(
        f.request("/v1/me/usage", Value::Null, true).await.0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn password_reset_revokes_devices_and_is_one_use() {
    let f = Fixture::new();
    f.register().await;
    assert_eq!(f.login().await, StatusCode::OK);
    assert_eq!(
        f.request(
            "/v1/password/request",
            json!({"email":"alice@example.com"}),
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    let code: String = f
        .app
        .db
        .lock()
        .unwrap()
        .query_row("SELECT code FROM outbox WHERE kind='reset'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let reset =
        json!({"email":"alice@example.com","code":code,"password":"new sufficiently long phrase"});
    assert_eq!(
        f.request("/v1/password/reset", reset.clone(), false)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request("/v1/password/reset", reset, false).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request("/v1/me/usage", Value::Null, true).await.0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn signature_body_tampering_and_nonce_replay() {
    let f = Fixture::new();
    f.register().await;
    assert_eq!(f.login().await, StatusCode::OK);
    let path = "/v1/me/usage";
    let stamp = chrono::Utc::now().timestamp().to_string();
    let nonce = Uuid::new_v4().to_string();
    let input = format!(
        "TIZI1\nGET\n{path}\n{}\n{stamp}\n{nonce}\n{}",
        f.id,
        hex::encode(Sha256::digest([]))
    );
    let signature = STANDARD.encode(f.key.sign(input.as_bytes()).to_bytes());
    for expected in [StatusCode::OK, StatusCode::UNAUTHORIZED] {
        let request = Request::builder()
            .uri(path)
            .header("X-Tizi-Device", &f.id)
            .header("X-Tizi-Timestamp", &stamp)
            .header("X-Tizi-Nonce", &nonce)
            .header("X-Tizi-Signature", &signature)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router(f.app.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            expected
        );
    }
    let request = Request::builder()
        .method("POST")
        .uri("/v1/usage/report")
        .header("X-Tizi-Device", &f.id)
        .header("X-Tizi-Timestamp", stamp)
        .header("X-Tizi-Nonce", Uuid::new_v4().to_string())
        .header("X-Tizi-Signature", signature)
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(
        router(f.app.clone())
            .oneshot(request)
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn code_expiry_attempt_limit_and_pending_cannot_complete() {
    let f = Fixture::new();
    f.request(
        "/v1/registration/request",
        json!({"email":"alice@example.com"}),
        false,
    )
    .await;
    assert_eq!(f.request("/v1/registration/complete",json!({"email":"alice@example.com","code":"000000","password":"a sufficiently long phrase"}),false).await.0,StatusCode::UNAUTHORIZED);
    f.app.approve("alice@example.com").unwrap();
    let code: String = f
        .app
        .db
        .lock()
        .unwrap()
        .query_row("SELECT code FROM outbox", [], |r| r.get(0))
        .unwrap();
    for _ in 0..5 {
        assert_eq!(f.request("/v1/registration/complete",json!({"email":"alice@example.com","code":"invalid","password":"a sufficiently long phrase"}),false).await.0,StatusCode::UNAUTHORIZED);
    }
    assert_eq!(f.request("/v1/registration/complete",json!({"email":"alice@example.com","code":code,"password":"a sufficiently long phrase"}),false).await.0,StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn published_subscription_has_no_userinfo_header() {
    let f = Fixture::new();
    f.register().await;
    assert_eq!(f.login().await, StatusCode::OK);
    let path = f._dir.path().join("config.yaml");
    std::fs::write(&path, "proxies: []\nrules: [MATCH,DIRECT]\n").unwrap();
    f.app.publish(&path).unwrap();
    let (_, value) = f.request("/v1/subscription", Value::Null, true).await;
    assert!(value["text"].as_str().unwrap().contains("proxies"));
    std::fs::write(&path, "invalid: [").unwrap();
    assert!(f.app.publish(&path).is_err());
    assert_eq!(
        f.app
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM subscription", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn seven_am_boundary() {
    let just_before = chrono::DateTime::parse_from_rfc3339("2026-10-30T06:59:59+08:00")
        .unwrap()
        .timestamp();
    assert_eq!(settlement_day(just_before).to_string(), "2026-10-29");
    assert_eq!(settlement_day(just_before + 1).to_string(), "2026-10-30");
    assert_eq!(next_boundary(just_before), just_before + 1);
    assert_eq!(next_boundary(just_before + 1), just_before + 1 + 86400);
}

#[tokio::test]
async fn tracking_tokens_are_fresh_and_existing_accounts_are_concealed() {
    let f = Fixture::new();
    let (_, a) = f
        .request(
            "/v1/registration/request",
            json!({"email":"alice@example.com"}),
            false,
        )
        .await;
    let (_, b) = f
        .request(
            "/v1/registration/request",
            json!({"email":"alice@example.com"}),
            false,
        )
        .await;
    assert_ne!(a["request_id"], b["request_id"]);
    f.app.approve("alice@example.com").unwrap();
    let (_, status) = f
        .request(
            "/v1/registration/status",
            json!({"request_id":a["request_id"]}),
            false,
        )
        .await;
    assert_eq!(status["status"], "approved");
    let code: String = f
        .app
        .db
        .lock()
        .unwrap()
        .query_row("SELECT code FROM outbox", [], |r| r.get(0))
        .unwrap();
    f.request(
        "/v1/registration/complete",
        json!({"email":"alice@example.com","code":code,"password":"a sufficiently long phrase"}),
        false,
    )
    .await;
    let (_, c) = f
        .request(
            "/v1/registration/request",
            json!({"email":"alice@example.com"}),
            false,
        )
        .await;
    let (_, status) = f
        .request(
            "/v1/registration/status",
            json!({"request_id":c["request_id"]}),
            false,
        )
        .await;
    assert_eq!(status["status"], "pending");
}
#[tokio::test]
async fn oversized_and_duplicate_day_reports_roll_back_atomically() {
    let f = Fixture::new();
    f.register().await;
    f.login().await;
    let day = settlement_day(chrono::Utc::now().timestamp()).to_string();
    let huge = json!({"sequence":1,"days":[{"day":day,"upload_bytes":9007199254740991u64,"download_bytes":1}]});
    assert_eq!(
        f.request("/v1/usage/report", huge, true).await.0,
        StatusCode::BAD_REQUEST
    );
    let duplicate = json!({"sequence":1,"days":[{"day":day,"upload_bytes":1,"download_bytes":1},{"day":day,"upload_bytes":2,"download_bytes":2}]});
    assert_eq!(
        f.request("/v1/usage/report", duplicate, true).await.0,
        StatusCode::BAD_REQUEST
    );
    let (_, view) = f.request("/v1/me/usage", Value::Null, true).await;
    assert_eq!(view["days"], json!([]));
    assert_eq!(view["devices"][0]["sequence"], 0);
}
#[tokio::test]
async fn multiple_devices_and_late_reports_update_historical_cycles() {
    let f = Fixture::new();
    f.register().await;
    f.login().await;
    let second = Fixture {
        app: f.app.clone(),
        _dir: tempfile::tempdir().unwrap(),
        key: SigningKey::from_bytes(&[8; 32]),
        id: Uuid::new_v4().to_string(),
    };
    assert_eq!(second.login().await, StatusCode::OK);
    let today = settlement_day(chrono::Utc::now().timestamp());
    let yesterday = (today - chrono::Duration::days(1)).to_string();
    {
        let c = f.app.db.lock().unwrap();
        c.execute("UPDATE cycles SET start_day=?1", [&yesterday])
            .unwrap();
        c.execute(
            "INSERT INTO cycles(name,start_day) VALUES('new cycle',?1)",
            [today.to_string()],
        )
        .unwrap();
    }
    for (client, bytes) in [(&f, 10), (&second, 20)] {
        assert_eq!(client.request("/v1/usage/report",json!({"sequence":1,"days":[{"day":yesterday,"upload_bytes":bytes,"download_bytes":0}],"health":{"healthy":true}}),true).await.0,StatusCode::OK);
    }
    assert_eq!(f.request("/v1/usage/report",json!({"sequence":2,"days":[{"day":yesterday,"upload_bytes":50,"download_bytes":0}],"health":{"healthy":false}}),true).await.0,StatusCode::OK);
    let (_, view) = f.request("/v1/me/usage", Value::Null, true).await;
    assert_eq!(view["days"][0]["upload_bytes"], 70);
    assert_eq!(view["cycles"][0]["upload_bytes"], 70);
    assert_eq!(view["cycles"][1]["upload_bytes"], 0);
    assert_eq!(view["devices"].as_array().unwrap().len(), 2);
    assert!(
        view["devices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["health"] == "incomplete")
    );
}

#[tokio::test]
async fn expired_code_cannot_register() {
    let f = Fixture::new();
    f.request(
        "/v1/registration/request",
        json!({"email":"alice@example.com"}),
        false,
    )
    .await;
    f.app.approve("alice@example.com").unwrap();
    let code: String = {
        let c = f.app.db.lock().unwrap();
        let code = c
            .query_row("SELECT code FROM outbox", [], |r| r.get(0))
            .unwrap();
        c.execute("UPDATE codes SET expires=1", []).unwrap();
        code
    };
    assert_eq!(f.request("/v1/registration/complete",json!({"email":"alice@example.com","code":code,"password":"a sufficiently long phrase"}),false).await.0,StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn actual_native_complete_health_is_normalized_without_hiding_errors() {
    let f = Fixture::new();
    f.register().await;
    f.login().await;
    let cases = [
        (json!({"complete":true}), "healthy"),
        (
            json!({"complete":false,"unclean_shutdown":true}),
            "incomplete",
        ),
        (json!({"complete":true,"healthy":false}), "incomplete"),
        (
            json!({"complete":true,"unclean_shutdown":true}),
            "incomplete",
        ),
        (json!({"complete":false,"healthy":true}), "incomplete"),
    ];
    for (index, (health, expected)) in cases.into_iter().enumerate() {
        assert_eq!(
            f.request(
                "/v1/usage/report",
                json!({"sequence":index+1,"days":[],"health":health}),
                true
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, view) = f.request("/v1/me/usage", Value::Null, true).await;
        assert_eq!(view["devices"][0]["health"], expected);
        assert_eq!(view["devices"][0]["health_details"], health);
    }
}
