use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    transport::smtp::authentication::Credentials,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tizi_server::{App, database_path, load_pepper, pepper_path, settlement_day, usage_view};

#[derive(Parser)]
#[command(
    version,
    about = "Private group subscription service; manual build/deployment only"
)]
struct Cli {
    #[arg(
        long,
        help = "Database path; overrides TIZI_DATABASE and the platform data directory"
    )]
    database: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Init,
    Serve {
        #[arg(long, env = "TIZI_LISTEN", default_value = "127.0.0.1:9876")]
        listen: String,
    },
    Pending,
    Approve {
        email: String,
    },
    Reject {
        email: String,
    },
    Users,
    Disable {
        email: String,
    },
    Devices {
        email: String,
    },
    Revoke {
        device_id: String,
    },
    Publish {
        #[arg(long)]
        file: PathBuf,
    },
    CycleOpen {
        #[arg(long)]
        name: String,
    },
    Cycles,
    Stats {
        #[arg(long, conflicts_with = "cycle")]
        day: Option<String>,
        #[arg(long)]
        cycle: Option<i64>,
    },
    Backup {
        #[arg(long)]
        output: PathBuf,
    },
}
fn rows(c: &rusqlite::Connection, sql: &str, arg: Option<&str>) -> Result<Value> {
    let mut st = c.prepare(sql)?;
    let cols = st.column_names().map(|s| s.to_string()).collect::<Vec<_>>();
    let get = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
        let mut map = serde_json::Map::new();
        for (i, name) in cols.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let value = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(i) => json!(i),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                ValueRef::Blob(_) => json!("[binary]"),
            };
            map.insert(name.clone(), value);
        }
        Ok(map.into())
    };
    let values = if let Some(a) = arg {
        st.query_map([a], get)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        st.query_map([], get)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(values.into())
}
fn smtp() -> Result<(AsyncSmtpTransport<Tokio1Executor>, String)> {
    let host = std::env::var("SMTP_HOST").context("SMTP_HOST is required")?;
    let from = std::env::var("SMTP_FROM").context("SMTP_FROM is required")?;
    let user = std::env::var("SMTP_USERNAME").context("SMTP_USERNAME is required")?;
    let pass = std::env::var("SMTP_PASSWORD").context("SMTP_PASSWORD is required")?;
    let port = std::env::var("SMTP_PORT")
        .unwrap_or_else(|_| "587".into())
        .parse()?;
    let builder = if port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)?
    };
    Ok((
        builder
            .port(port)
            .credentials(Credentials::new(user, pass))
            .timeout(Some(Duration::from_secs(30)))
            .build(),
        from,
    ))
}
async fn mail_worker(app: App, transport: AsyncSmtpTransport<Tokio1Executor>, from: String) {
    loop {
        let entry = {
            let c = app.db.lock().unwrap();
            let n = chrono::Utc::now().timestamp();
            let _ = c.execute("DELETE FROM outbox WHERE expires<?1", [n]);
            c.query_row("SELECT id,email,kind,code,attempts FROM outbox WHERE retry_at<=?1 AND expires>?1 ORDER BY id LIMIT 1",[n],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,u32>(4)?))).optional()
        };
        match entry {
            Ok(Some((id, email, kind, code, attempts))) => {
                let result=async {let subject=if kind=="registration"{"新团购 tizi 注册验证码"}else{"新团购 tizi 密码重置验证码"};let message=Message::builder().from(from.parse()?).to(email.parse()?).subject(subject).body(format!("您的验证码：{code}\n\n验证码有效期10分钟。请勿转发。若非本人操作，请忽略此邮件。"))?;transport.send(message).await?;Ok::<_,anyhow::Error>(())}.await;
                let c = app.db.lock().unwrap();
                if result.is_ok() {
                    let _ = c.execute("DELETE FROM outbox WHERE id=?1", [id]);
                } else {
                    let delay = (5i64 * 2i64.pow(attempts.min(6))).min(300);
                    let _ = c.execute(
                        "UPDATE outbox SET attempts=attempts+1,retry_at=?1 WHERE id=?2",
                        params![chrono::Utc::now().timestamp() + delay, id],
                    );
                    tracing::warn!(outbox_id = id, "Email delivery failed; retry scheduled");
                }
            }
            Ok(None) => {}
            Err(_) => tracing::error!("Unable to read mail outbox"),
        };
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(p) = std::env::var_os("TIZI_PRIVATE_DIRECTORY") {
            std::fs::create_dir_all(&p)?;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tizi_server=info".into()),
        )
        .init();
    let cli = Cli::parse();
    #[cfg(unix)]
    let is_root = unsafe { libc::geteuid() == 0 };
    #[cfg(not(unix))]
    let is_root = false;
    let database = database_path(
        cli.database.as_deref(),
        std::env::var_os("TIZI_DATABASE").as_deref(),
        std::env::var_os("XDG_DATA_HOME").as_deref(),
        std::env::var_os("HOME").as_deref(),
        is_root,
    )?;
    let create = matches!(cli.command, Command::Init);
    if let Some(parent) = database.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let app = App::open(&database, load_pepper(&pepper_path(&database), create)?)?;
    let result = match cli.command {
        Command::Init => json!({"initialized":true,"database":database}),
        Command::Serve { listen } => {
            let lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(database.with_extension("serve.lock"))?;
            lock.try_lock()
                .context("another process is already serving this database")?;
            let (transport, from) = smtp()?;
            tokio::spawn(mail_worker(app.clone(), transport, from));
            let listener = tokio::net::TcpListener::bind(&listen).await?;
            tracing::info!(%listen,"Subscription service listening");
            axum::serve(listener, tizi_server::router(app))
                .with_graceful_shutdown(async {
                    #[cfg(unix)]
                    {
                        if let Ok(mut term) = tokio::signal::unix::signal(
                            tokio::signal::unix::SignalKind::terminate(),
                        ) {
                            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
                        } else {
                            let _ = tokio::signal::ctrl_c().await;
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = tokio::signal::ctrl_c().await;
                    }
                })
                .await?;
            return Ok(());
        }
        Command::Pending => rows(
            &app.db.lock().unwrap(),
            "SELECT email,status,created_at FROM users WHERE status IN ('pending','approved') ORDER BY created_at",
            None,
        )?,
        Command::Users => rows(
            &app.db.lock().unwrap(),
            "SELECT email,status,created_at FROM users ORDER BY email",
            None,
        )?,
        Command::Approve { email } => {
            app.approve(&email)?;
            json!({"approved":email,"mail":"queued"})
        }
        Command::Reject { email } => {
            let n=app.db.lock().unwrap().execute("UPDATE users SET status='rejected' WHERE email=?1 AND status IN ('pending','approved')",[&email])?;
            if n == 0 {
                bail!("no pending registration")
            };
            json!({"rejected":email})
        }
        Command::Disable { email } => {
            let mut c = app.db.lock().unwrap();
            let tx = c.transaction()?;
            if tx.execute(
                "UPDATE users SET status='disabled' WHERE email=?1",
                [&email],
            )? == 0
            {
                bail!("user not found")
            };
            tx.execute("UPDATE devices SET revoked=1 WHERE email=?1", [&email])?;
            tx.execute("DELETE FROM outbox WHERE email=?1", [&email])?;
            tx.execute("DELETE FROM codes WHERE email=?1", [&email])?;
            tx.commit()?;
            json!({"disabled":email})
        }
        Command::Devices { email } => rows(
            &app.db.lock().unwrap(),
            "SELECT id,name,revoked,sequence,last_report_at,health FROM devices WHERE email=?1",
            Some(&email),
        )?,
        Command::Revoke { device_id } => {
            if app
                .db
                .lock()
                .unwrap()
                .execute("UPDATE devices SET revoked=1 WHERE id=?1", [&device_id])?
                == 0
            {
                bail!("device not found")
            };
            json!({"revoked":device_id})
        }
        Command::Publish { file } => json!({"revision":app.publish(&file)?}),
        Command::CycleOpen { name } => {
            json!({"start_day":app.open_cycle(&name)?.to_string(),"name":name,"boundary":"07:00 Asia/Shanghai"})
        }
        Command::Cycles => rows(
            &app.db.lock().unwrap(),
            "SELECT id,name,start_day FROM cycles ORDER BY start_day",
            None,
        )?,
        Command::Backup { output } => {
            if output.exists() {
                bail!("backup target already exists")
            };
            let c = app.db.lock().unwrap();
            c.backup(rusqlite::MAIN_DB, &output, rusqlite::backup::NO_PROGRESS)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o600))?;
            }
            json!({"backup":output,"also_back_up":pepper_path(&database)})
        }
        Command::Stats { day, cycle } => {
            let c = app.db.lock().unwrap();
            let day =
                day.unwrap_or_else(|| settlement_day(chrono::Utc::now().timestamp()).to_string());
            let mut st = c.prepare(
                "SELECT email FROM users WHERE status IN ('registered','disabled') ORDER BY email",
            )?;
            let emails = st
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut values = Vec::new();
            let mut total = 0u64;
            for e in emails {
                let view = usage_view(&c, &e)?;
                let items = if cycle.is_some() {
                    view["cycles"].as_array().unwrap()
                } else {
                    view["days"].as_array().unwrap()
                };
                let item = items.iter().find(|v| {
                    if let Some(id) = cycle {
                        v["id"].as_i64() == Some(id)
                    } else {
                        v["day"].as_str() == Some(&day)
                    }
                });
                let u = item.and_then(|v| v["upload_bytes"].as_u64()).unwrap_or(0);
                let d = item.and_then(|v| v["download_bytes"].as_u64()).unwrap_or(0);
                total = total
                    .checked_add(u)
                    .and_then(|n| n.checked_add(d))
                    .context("statistics overflow")?;
                let devices = view["devices"].as_array().unwrap();
                let overdue = devices
                    .iter()
                    .filter(|v| {
                        v["last_report_at"]
                            .as_i64()
                            .is_none_or(|t| t < chrono::Utc::now().timestamp() - 86400)
                    })
                    .count();
                values.push(json!({"email":e,"upload_bytes":u,"download_bytes":d,"total_bytes":u+d,"overdue_devices":overdue,"devices":devices}));
            }
            for v in &mut values {
                v["percentage"] = json!(if total == 0 {
                    0.0
                } else {
                    v["total_bytes"].as_u64().unwrap() as f64 * 100.0 / total as f64
                });
            }
            json!({"day":day,"cycle":cycle,"total_bytes":total,"users":values,"note":"Client-reported payload bytes; late reports may revise totals. Missing reports are incomplete, not verified zero usage."})
        }
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
