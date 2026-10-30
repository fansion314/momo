use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Datelike, Duration as Days, FixedOffset, NaiveDate, TimeZone, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use argon2::{Argon2, PasswordHasher, PasswordVerifier, password_hash::phc::PasswordHash};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

#[derive(Clone)]
pub struct App {
    pub db: Arc<Mutex<Connection>>,
    pepper: Arc<Vec<u8>>,
}
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, axum::Json(json!({"error":self.1}))).into_response()
    }
}
type ApiResult<T> = std::result::Result<T, ApiError>;
fn internal(_: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
}
fn invalid() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "invalid_request")
}
fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "unauthorized")
}
fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "conflict")
}
fn body<T: serde::de::DeserializeOwned>(b: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(b).map_err(|_| invalid())
}
fn now() -> i64 {
    Utc::now().timestamp()
}
pub fn settlement_day(timestamp: i64) -> NaiveDate {
    DateTime::<Utc>::from_timestamp(timestamp, 0)
        .unwrap()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .date_naive()
        .pred_opt()
        .filter(|_| (timestamp + 8 * 3600).rem_euclid(86400) < 7 * 3600)
        .unwrap_or_else(|| {
            DateTime::<Utc>::from_timestamp(timestamp, 0)
                .unwrap()
                .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
                .date_naive()
        })
}
pub fn next_boundary(timestamp: i64) -> i64 {
    let d = settlement_day(timestamp) + Days::days(1);
    FixedOffset::east_opt(8 * 3600)
        .unwrap()
        .from_local_datetime(&d.and_hms_opt(7, 0, 0).unwrap())
        .unwrap()
        .timestamp()
}
fn email(s: &str) -> ApiResult<String> {
    let s = s.trim().to_ascii_lowercase();
    if s.len() > 254
        || s.chars().any(char::is_whitespace)
        || s.contains(['\r', '\n'])
        || s.split('@').count() != 2
        || !s.split('@').next_back().unwrap_or("").contains('.')
        || s.parse::<lettre::Address>().is_err()
    {
        return Err(invalid());
    }
    Ok(s)
}
fn password(s: &str) -> ApiResult<()> {
    if !(10..=128).contains(&s.chars().count()) {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn hash_password(s: &str) -> ApiResult<String> {
    Argon2::default()
        .hash_password(s.as_bytes())
        .map(|p| p.to_string())
        .map_err(internal)
}
fn check_password(hash: &str, s: &str) -> bool {
    PasswordHash::new(hash)
        .ok()
        .is_some_and(|p| Argon2::default().verify_password(s.as_bytes(), &p).is_ok())
}

impl App {
    pub fn open(path: &Path, pepper: Vec<u8>) -> Result<Self> {
        if pepper.len() < 32 {
            bail!("code pepper requires at least 32 bytes")
        };
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        // SQLite derives WAL/SHM permissions from the database file. Create and
        // restrict it before SQLite can create journals containing mail codes.
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .mode(0o600)
                .open(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        let c = Connection::open(path)?;
        c.busy_timeout(Duration::from_secs(5))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY,status TEXT NOT NULL,request_id TEXT UNIQUE NOT NULL,password TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS codes(email TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,issued INTEGER NOT NULL,PRIMARY KEY(email,kind));
 CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,kind TEXT NOT NULL,code TEXT NOT NULL,expires INTEGER NOT NULL,retry_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,email TEXT NOT NULL REFERENCES users(email),public_key TEXT NOT NULL,name TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT 0,report_hash TEXT,last_report_at INTEGER,health TEXT);
 CREATE TABLE IF NOT EXISTS nonces(device_id TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(device_id,nonce));
 CREATE TABLE IF NOT EXISTS usage(device_id TEXT NOT NULL REFERENCES devices(id),day TEXT NOT NULL,upload INTEGER NOT NULL,download INTEGER NOT NULL,PRIMARY KEY(device_id,day));
 CREATE TABLE IF NOT EXISTS cycles(id INTEGER PRIMARY KEY,name TEXT NOT NULL,start_day TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS subscription(id INTEGER PRIMARY KEY CHECK(id=1),yaml TEXT NOT NULL,revision TEXT NOT NULL,published_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,start INTEGER NOT NULL,count INTEGER NOT NULL);")?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS registration_tokens(id TEXT PRIMARY KEY,email TEXT NOT NULL,concealed INTEGER NOT NULL DEFAULT 0);")?;
        c.execute(
            "INSERT OR IGNORE INTO cycles(id,name,start_day) VALUES(1,'初始周期',?1)",
            [settlement_day(now()).to_string()],
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self {
            db: Arc::new(Mutex::new(c)),
            pepper: Arc::new(pepper),
        })
    }
    fn lock(&self) -> ApiResult<std::sync::MutexGuard<'_, Connection>> {
        self.db.lock().map_err(internal)
    }
    fn rate(c: &Connection, key: &str, max: i64, window: i64) -> ApiResult<()> {
        let t = now();
        c.execute("INSERT INTO limits(key,start,count) VALUES(?1,?2,1) ON CONFLICT(key) DO UPDATE SET start=CASE WHEN start<=?3 THEN ?2 ELSE start END,count=CASE WHEN start<=?3 THEN 1 ELSE count+1 END",params![key,t,t-window]).map_err(internal)?;
        let n: i64 = c
            .query_row("SELECT count FROM limits WHERE key=?1", [key], |r| r.get(0))
            .map_err(internal)?;
        if n > max {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
        }
        Ok(())
    }
    fn code_hash(&self, email: &str, kind: &str, code: &str) -> String {
        let mut h = Sha256::new();
        h.update(&*self.pepper);
        h.update(format!("\n{email}\n{kind}\n{code}"));
        hex::encode(h.finalize())
    }
    fn issue(&self, c: &Connection, email: &str, kind: &str) -> ApiResult<()> {
        let issued: Option<i64> = c
            .query_row(
                "SELECT issued FROM codes WHERE email=?1 AND kind=?2",
                params![email, kind],
                |r| r.get(0),
            )
            .optional()
            .map_err(internal)?;
        if issued.is_some_and(|t| now() - t < 60) {
            return Ok(());
        }
        Self::rate(c, &format!("mail:{email}"), 10, 3600)?;
        let code = format!("{:06}", rand::random_range(0..1_000_000));
        let expires = now() + 600;
        c.execute("INSERT INTO codes VALUES(?1,?2,?3,?4,0,?5) ON CONFLICT(email,kind) DO UPDATE SET hash=excluded.hash,expires=excluded.expires,attempts=0,issued=excluded.issued",params![email,kind,self.code_hash(email,kind,&code),expires,now()]).map_err(internal)?;
        c.execute(
            "DELETE FROM outbox WHERE email=?1 AND kind=?2",
            params![email, kind],
        )
        .map_err(internal)?;
        c.execute(
            "INSERT INTO outbox(email,kind,code,expires,retry_at) VALUES(?1,?2,?3,?4,?5)",
            params![email, kind, code, expires, now()],
        )
        .map_err(internal)?;
        Ok(())
    }
    fn verify_code(&self, c: &Connection, email: &str, kind: &str, code: &str) -> ApiResult<()> {
        let entry: Option<(String, i64, i64)> = c
            .query_row(
                "SELECT hash,expires,attempts FROM codes WHERE email=?1 AND kind=?2",
                params![email, kind],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(internal)?;
        let Some((hash, expires, attempts)) = entry else {
            return Err(unauthorized());
        };
        if expires < now() || attempts >= 5 {
            return Err(unauthorized());
        }
        c.execute(
            "UPDATE codes SET attempts=attempts+1 WHERE email=?1 AND kind=?2",
            params![email, kind],
        )
        .map_err(internal)?;
        if hash
            .as_bytes()
            .ct_eq(self.code_hash(email, kind, code).as_bytes())
            .into()
        {
            Ok(())
        } else {
            Err(unauthorized())
        }
    }
    pub fn approve(&self, e: &str) -> Result<()> {
        let e = email(e).map_err(|_| anyhow::anyhow!("invalid email"))?;
        let c = self.lock().map_err(|_| anyhow::anyhow!("database lock"))?;
        let changed=c.execute("UPDATE users SET status='approved' WHERE email=?1 AND status IN ('pending','approved')",[&e])?;
        if changed == 0 {
            bail!("no pending registration")
        };
        self.issue(&c, &e, "registration")
            .map_err(|e| anyhow::anyhow!("code issuance failed: {}", e.1))?;
        Ok(())
    }
    pub fn publish(&self, path: &Path) -> Result<String> {
        let bytes = std::fs::read(path)?;
        if bytes.len() > 10 * 1024 * 1024 {
            bail!("subscription too large")
        };
        let text = String::from_utf8(bytes)?;
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&text).context("invalid YAML")?;
        if !v.is_mapping()
            || (!v.get("proxies").is_some_and(|x| x.is_sequence())
                && !v.get("proxy-providers").is_some_and(|x| x.is_mapping()))
        {
            bail!("subscription requires proxies or proxy-providers")
        };
        let revision = hex::encode(Sha256::digest(text.as_bytes()));
        self.db.lock().unwrap().execute("INSERT INTO subscription VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET yaml=excluded.yaml,revision=excluded.revision,published_at=excluded.published_at",params![text,revision,now()])?;
        Ok(revision)
    }
    pub fn open_cycle(&self, name: &str) -> Result<NaiveDate> {
        if name.trim().is_empty() || name.len() > 100 {
            bail!("invalid cycle name")
        };
        let date = settlement_day(now()) + Days::days(1);
        self.db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO cycles(name,start_day) VALUES(?1,?2)",
                params![name, date.to_string()],
            )
            .context("a cycle already starts at the next boundary")?;
        Ok(date)
    }
    fn signed(
        &self,
        c: &Connection,
        method: &str,
        path: &str,
        h: &HeaderMap,
        b: &[u8],
        supplied: Option<&str>,
    ) -> ApiResult<String> {
        let read = |name: &str| -> ApiResult<&str> {
            h.get(name)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(unauthorized)
        };
        let id = read("x-tizi-device")?;
        Uuid::parse_str(id).map_err(|_| unauthorized())?;
        let stamp = read("x-tizi-timestamp")?;
        let ts: i64 = stamp.parse().map_err(|_| unauthorized())?;
        if now().abs_diff(ts) > 300 {
            return Err(unauthorized());
        }
        let nonce = read("x-tizi-nonce")?;
        Uuid::parse_str(nonce).map_err(|_| unauthorized())?;
        let public = if let Some(p) = supplied {
            p.to_owned()
        } else {
            c.query_row("SELECT d.public_key FROM devices d JOIN users u ON u.email=d.email WHERE d.id=?1 AND d.revoked=0 AND u.status='registered'",[id],|r|r.get::<_,String>(0)).optional().map_err(internal)?.ok_or_else(unauthorized)?
        };
        let bytes: [u8; 32] = STANDARD
            .decode(public)
            .map_err(|_| unauthorized())?
            .try_into()
            .map_err(|_| unauthorized())?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| unauthorized())?;
        let sig = Signature::from_slice(
            &STANDARD
                .decode(read("x-tizi-signature")?)
                .map_err(|_| unauthorized())?,
        )
        .map_err(|_| unauthorized())?;
        let message = format!(
            "TIZI1\n{method}\n{path}\n{id}\n{stamp}\n{nonce}\n{}",
            hex::encode(Sha256::digest(b))
        );
        key.verify_strict(message.as_bytes(), &sig)
            .map_err(|_| unauthorized())?;
        c.execute("DELETE FROM nonces WHERE expires<?1", [now()])
            .map_err(internal)?;
        c.execute(
            "INSERT INTO nonces VALUES(?1,?2,?3)",
            params![id, nonce, now() + 600],
        )
        .map_err(|_| unauthorized())?;
        Ok(id.to_owned())
    }
    fn execute(&self, method: &str, path: &str, h: HeaderMap, b: Bytes) -> ApiResult<Response> {
        let mut c = self.lock()?;
        let route = path.split('?').next().unwrap();
        if route.starts_with("/v1/registration/")
            || route.starts_with("/v1/password/")
            || route == "/v1/login"
        {
            Self::rate(&c, &format!("public:{route}"), 120, 60)?;
        }
        match (method, route) {
            ("POST", "/v1/registration/request") => {
                #[derive(Deserialize)]
                struct R {
                    email: String,
                }
                let r: R = body(&b)?;
                let e = email(&r.email)?;
                Self::rate(&c, &format!("registration:{e}"), 5, 3600)?;
                let id = Uuid::new_v4().to_string();
                c.execute(
                    "INSERT OR IGNORE INTO users VALUES(?1,'pending',?2,NULL,?3)",
                    params![e, id, now()],
                )
                .map_err(internal)?;
                let (_, status): (String, String) = c
                    .query_row(
                        "SELECT request_id,status FROM users WHERE email=?1",
                        [&e],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(internal)?;
                if status == "approved" {
                    self.issue(&c, &e, "registration")?;
                }
                c.execute(
                    "INSERT INTO registration_tokens VALUES(?1,?2,?3)",
                    params![id, e, !matches!(status.as_str(), "pending" | "approved")],
                )
                .map_err(internal)?;
                Ok(axum::Json(json!({"request_id":id})).into_response())
            }
            ("POST", "/v1/registration/status") => {
                #[derive(Deserialize)]
                struct R {
                    request_id: String,
                }
                let r: R = body(&b)?;
                let s: String = c
                    .query_row(
                        "SELECT CASE WHEN t.concealed=1 THEN 'pending' ELSE u.status END FROM registration_tokens t JOIN users u ON u.email=t.email WHERE t.id=?1",
                        [r.request_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(internal)?
                    .ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
                Ok(axum::Json(json!({"status":s})).into_response())
            }
            ("POST", "/v1/registration/complete") | ("POST", "/v1/password/reset") => {
                #[derive(Deserialize)]
                struct R {
                    email: String,
                    code: String,
                    password: String,
                }
                let r: R = body(&b)?;
                let e = email(&r.email)?;
                password(&r.password)?;
                let registration = route.contains("registration");
                let kind = if registration {
                    "registration"
                } else {
                    "reset"
                };
                let required = if registration {
                    "approved"
                } else {
                    "registered"
                };
                let s: Option<String> = c
                    .query_row("SELECT status FROM users WHERE email=?1", [&e], |r| {
                        r.get(0)
                    })
                    .optional()
                    .map_err(internal)?;
                if s.as_deref() != Some(required) {
                    return Err(unauthorized());
                }
                self.verify_code(&c, &e, kind, &r.code)?;
                let hash = hash_password(&r.password)?;
                let tx = c.transaction().map_err(internal)?;
                tx.execute(
                    "UPDATE users SET password=?1,status='registered' WHERE email=?2",
                    params![hash, e],
                )
                .map_err(internal)?;
                tx.execute("DELETE FROM codes WHERE email=?1", [&e])
                    .map_err(internal)?;
                tx.execute("DELETE FROM outbox WHERE email=?1", [&e])
                    .map_err(internal)?;
                if !registration {
                    tx.execute("UPDATE devices SET revoked=1 WHERE email=?1", [&e])
                        .map_err(internal)?;
                }
                tx.commit().map_err(internal)?;
                Ok(axum::Json(json!({"ok":true})).into_response())
            }
            ("POST", "/v1/password/request") => {
                #[derive(Deserialize)]
                struct R {
                    email: String,
                }
                let r: R = body(&b)?;
                let e = email(&r.email)?;
                Self::rate(&c, &format!("reset:{e}"), 5, 3600)?;
                let s: Option<String> = c
                    .query_row("SELECT status FROM users WHERE email=?1", [&e], |r| {
                        r.get(0)
                    })
                    .optional()
                    .map_err(internal)?;
                if s.as_deref() == Some("registered") {
                    self.issue(&c, &e, "reset")?;
                }
                Ok(axum::Json(json!({"ok":true})).into_response())
            }
            ("POST", "/v1/login") => {
                #[derive(Deserialize)]
                struct R {
                    email: String,
                    password: String,
                    device_id: String,
                    public_key: String,
                    device_name: String,
                }
                let r: R = body(&b)?;
                let e = email(&r.email)?;
                Self::rate(&c, &format!("login:{e}"), 10, 600)?;
                let id = self.signed(&c, method, path, &h, &b, Some(&r.public_key))?;
                if id != r.device_id || r.device_name.len() > 128 {
                    return Err(invalid());
                };
                let hash: Option<String> = c
                    .query_row(
                        "SELECT password FROM users WHERE email=?1 AND status='registered'",
                        [&e],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(internal)?;
                if !hash.is_some_and(|hash| check_password(&hash, &r.password)) {
                    return Err(unauthorized());
                };
                let old: Option<(String, String)> = c
                    .query_row(
                        "SELECT email,public_key FROM devices WHERE id=?1",
                        [&id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(internal)?;
                if old.is_some_and(|(owner, key)| owner != e || key != r.public_key) {
                    return Err(conflict());
                };
                c.execute("INSERT INTO devices(id,email,public_key,name) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revoked=0",params![id,e,r.public_key,r.device_name]).map_err(internal)?;
                Ok(axum::Json(json!({"device_id":id,"email":e})).into_response())
            }
            ("GET", "/v1/subscription") => {
                self.signed(&c, method, path, &h, &b, None)?;
                let text: String = c
                    .query_row("SELECT yaml FROM subscription WHERE id=1", [], |r| r.get(0))
                    .optional()
                    .map_err(internal)?
                    .ok_or(ApiError(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "subscription_unavailable",
                    ))?;
                Ok((
                    [
                        ("content-type", "application/yaml; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    text,
                )
                    .into_response())
            }
            ("POST", "/v1/usage/report") => {
                let id = self.signed(&c, method, path, &h, &b, None)?;
                let r: Report = body(&b)?;
                if r.days.len() > 4000 || r.sequence == 0 || r.sequence > i64::MAX as u64 {
                    return Err(invalid());
                };
                let (seq, hash): (i64, Option<String>) = c
                    .query_row(
                        "SELECT sequence,report_hash FROM devices WHERE id=?1",
                        [&id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(internal)?;
                let newhash = hex::encode(Sha256::digest(&b));
                if r.sequence as i64 <= seq {
                    if r.sequence as i64 == seq && hash.as_deref() == Some(&newhash) {
                        return Ok(axum::Json(json!({"sequence":seq})).into_response());
                    }
                    return Err(conflict());
                }
                let health = r.health.map(|x| x.to_string());
                if health.as_ref().is_some_and(|h| h.len() > 4096) {
                    return Err(invalid());
                };
                let tx = c.transaction().map_err(internal)?;
                let mut seen = std::collections::HashSet::new();
                let mut user_total:i64=tx.query_row("SELECT COALESCE(SUM(upload+download),0) FROM usage JOIN devices ON devices.id=usage.device_id WHERE email=(SELECT email FROM devices WHERE id=?1)", [&id], |r|r.get(0)).map_err(internal)?;
                for d in r.days {
                    let day =
                        NaiveDate::parse_from_str(&d.day, "%Y-%m-%d").map_err(|_| invalid())?;
                    if day.to_string() != d.day
                        || day > settlement_day(now())
                        || day.year() < 2020
                        || !seen.insert(d.day.clone())
                        || d.upload_bytes > 9_007_199_254_740_991
                        || d.download_bytes > 9_007_199_254_740_991
                    {
                        return Err(invalid());
                    }
                    let old: Option<(i64, i64)> = tx
                        .query_row(
                            "SELECT upload,download FROM usage WHERE device_id=?1 AND day=?2",
                            params![id, d.day],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()
                        .map_err(internal)?;
                    if old.is_some_and(|(u, v)| {
                        u as u64 > d.upload_bytes || v as u64 > d.download_bytes
                    }) {
                        return Err(conflict());
                    }
                    let (u, v) = old.unwrap_or((0, 0));
                    user_total = user_total
                        .checked_add(d.upload_bytes as i64 - u)
                        .and_then(|n| n.checked_add(d.download_bytes as i64 - v))
                        .filter(|n| *n <= 9_007_199_254_740_991)
                        .ok_or_else(invalid)?;
                    tx.execute("INSERT INTO usage VALUES(?1,?2,?3,?4) ON CONFLICT(device_id,day) DO UPDATE SET upload=excluded.upload,download=excluded.download",params![id,d.day,d.upload_bytes as i64,d.download_bytes as i64]).map_err(internal)?;
                }
                tx.execute("UPDATE devices SET sequence=?1,report_hash=?2,last_report_at=?3,health=?4 WHERE id=?5",params![r.sequence as i64,newhash,now(),health,id]).map_err(internal)?;
                tx.commit().map_err(internal)?;
                Ok(axum::Json(json!({"sequence":r.sequence})).into_response())
            }
            ("GET", "/v1/me/usage") => {
                let id = self.signed(&c, method, path, &h, &b, None)?;
                let e: String = c
                    .query_row("SELECT email FROM devices WHERE id=?1", [id], |r| r.get(0))
                    .map_err(internal)?;
                Ok(axum::Json(usage_view(&c, &e).map_err(internal)?).into_response())
            }
            _ => Err(ApiError(StatusCode::NOT_FOUND, "not_found")),
        }
    }
}
#[derive(Serialize, Deserialize)]
pub struct DayUsage {
    pub day: String,
    pub upload_bytes: u64,
    pub download_bytes: u64,
}
#[derive(Deserialize)]
struct Report {
    sequence: u64,
    days: Vec<DayUsage>,
    health: Option<Value>,
}
pub fn usage_view(c: &Connection, e: &str) -> Result<Value> {
    let mut st=c.prepare("SELECT day,SUM(upload),SUM(download) FROM usage JOIN devices ON devices.id=usage.device_id WHERE email=?1 GROUP BY day ORDER BY day")?;
    let days = st
        .query_map([e], |r| {
            Ok(DayUsage {
                day: r.get(0)?,
                upload_bytes: r.get::<_, i64>(1)? as u64,
                download_bytes: r.get::<_, i64>(2)? as u64,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut st = c.prepare("SELECT id,name,start_day FROM cycles ORDER BY start_day")?;
    let cycles = st
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let cycles:Vec<Value>=cycles.iter().enumerate().map(|(i,(id,name,start))|{let end=cycles.get(i+1).map(|x|&x.2);let(u,d)=days.iter().filter(|d|d.day>=*start&&end.is_none_or(|e|d.day<*e)).fold((0u64,0u64),|(u,v),d|(u+d.upload_bytes,v+d.download_bytes));json!({"id":id,"name":name,"start_day":start,"end_day":end,"upload_bytes":u,"download_bytes":d})}).collect();
    let mut st =
        c.prepare("SELECT id,name,last_report_at,sequence,health FROM devices WHERE email=?1")?;
    let devices=st.query_map([e],|r|{
        let raw:Option<String>=r.get(4)?;
        let details=raw.and_then(|h|serde_json::from_str::<Value>(&h).ok());
        let health=match details.as_ref(){
            Some(Value::String(s)) if ["healthy","incomplete","unknown"].contains(&s.as_str())=>s.as_str(),
            Some(Value::Object(o)) if o.get("complete")==Some(&Value::Bool(false)) || o.get("healthy")==Some(&Value::Bool(false)) || o.get("unclean_shutdown")==Some(&Value::Bool(true))=>"incomplete",
            Some(Value::Object(o)) if o.get("complete")==Some(&Value::Bool(true)) || o.get("healthy")==Some(&Value::Bool(true))=>"healthy",
            _=>"unknown"
        };
        Ok(json!({"device_id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"last_report_at":r.get::<_,Option<i64>>(2)?,"sequence":r.get::<_,i64>(3)?,"health":health,"health_details":details}))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({"email":e,"days":days,"cycles":cycles,"devices":devices}))
}
async fn handle(
    State(app): State<App>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    h: HeaderMap,
    b: Bytes,
) -> ApiResult<Response> {
    let path = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_owned();
    let method = method.to_string();
    let mut response = tokio::task::spawn_blocking(move || app.execute(&method, &path, h, b))
        .await
        .map_err(internal)??;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    Ok(response)
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/registration/request", post(handle))
        .route("/v1/registration/status", post(handle))
        .route("/v1/registration/complete", post(handle))
        .route("/v1/password/request", post(handle))
        .route("/v1/password/reset", post(handle))
        .route("/v1/login", post(handle))
        .route("/v1/subscription", get(handle))
        .route("/v1/usage/report", post(handle))
        .route("/v1/me/usage", get(handle))
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .with_state(app)
}

pub fn load_pepper(path: &Path, create: bool) -> Result<Vec<u8>> {
    if create && !path.exists() {
        let mut bytes = [0u8; 32];
        rand::fill(&mut bytes);
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        #[cfg(not(unix))]
        std::fs::write(path, bytes)?;
    }
    let b = std::fs::read(path)
        .context("initialize server first; protect and back up its .pepper file")?;
    if b.len() < 32 {
        bail!("invalid pepper")
    };
    Ok(b)
}
pub fn pepper_path(db: &Path) -> PathBuf {
    let mut s = db.as_os_str().to_os_string();
    s.push(".pepper");
    s.into()
}

/// Resolve one database location for every command, independently of the current
/// directory. Explicit arguments and the service-specific variable take precedence;
/// ordinary users follow XDG and root keeps the conventional system state path.
pub fn database_path(
    explicit: Option<&Path>,
    configured: Option<&std::ffi::OsStr>,
    xdg_data_home: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
    is_root: bool,
) -> Result<PathBuf> {
    if let Some(path) = explicit {
        anyhow::ensure!(!path.as_os_str().is_empty(), "--database must not be empty");
        return Ok(path.to_path_buf());
    }
    if let Some(path) = configured {
        anyhow::ensure!(!path.is_empty(), "TIZI_DATABASE must not be empty");
        return Ok(PathBuf::from(path));
    }
    if is_root {
        return Ok(PathBuf::from("/var/lib/tizi-server/tizi.db"));
    }
    if let Some(path) = xdg_data_home.map(Path::new).filter(|p| p.is_absolute()) {
        return Ok(path.join("tizi-server/tizi.db"));
    }
    let home = home
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .context("HOME is unavailable; set --database or TIZI_DATABASE explicitly")?;
    Ok(home.join(".local/share/tizi-server/tizi.db"))
}
