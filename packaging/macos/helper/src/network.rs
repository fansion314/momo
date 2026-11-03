use crate::files::write_json;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    net::IpAddr,
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ProxyRequest {
    pub enabled: bool,
    pub mode: String,
    pub host: String,
    pub port: i64,
    pub url: String,
    pub bypass: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct DnsRequest {
    pub enabled: bool,
    pub servers: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub(crate) struct NetworkValue {
    pub enabled: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub host: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub port: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(
        default,
        deserialize_with = "nullable_list",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub list: Vec<String>,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}
fn nullable_list<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Vec<String>, D::Error> {
    Ok(Option::<Vec<String>>::deserialize(d)?.unwrap_or_default())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct NetworkEntry {
    service: String,
    kind: String,
    before: NetworkValue,
    applied: NetworkValue,
    #[serde(
        default,
        deserialize_with = "nullable_values",
        skip_serializing_if = "Vec::is_empty"
    )]
    pending: Vec<NetworkValue>,
}
fn nullable_values<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Vec<NetworkValue>, D::Error> {
    Ok(Option::<Vec<NetworkValue>>::deserialize(d)?.unwrap_or_default())
}

#[derive(Default, Deserialize, Serialize)]
struct NetworkState {
    #[serde(default, deserialize_with = "nullable_entries")]
    entries: Vec<NetworkEntry>,
}
fn nullable_entries<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Vec<NetworkEntry>, D::Error> {
    Ok(Option::<Vec<NetworkEntry>>::deserialize(d)?.unwrap_or_default())
}

pub(crate) trait NetworkBackend: Send {
    fn services(&mut self) -> Result<Vec<String>>;
    fn get(&mut self, service: &str, kind: &str) -> Result<NetworkValue>;
    fn set(
        &mut self,
        service: &str,
        kind: &str,
        expected: &NetworkValue,
        value: &NetworkValue,
    ) -> Result<()>;
}

pub struct NetworkManager {
    path: PathBuf,
    state: NetworkState,
    backend: Box<dyn NetworkBackend>,
}

pub(crate) fn equivalent(kind: &str, a: &NetworkValue, b: &NetworkValue) -> bool {
    if kind != "autoproxyurl" {
        return a == b;
    }
    let mut a = a.clone();
    let mut b = b.clone();
    if a.url == "(null)" {
        a.url.clear();
    }
    if b.url == "(null)" {
        b.url.clear();
    }
    a == b
}

fn valid_kind(kind: &str) -> bool {
    matches!(
        kind,
        "webproxy"
            | "securewebproxy"
            | "socksfirewallproxy"
            | "autoproxyurl"
            | "proxyautodiscovery"
            | "proxybypassdomains"
            | "dnsservers"
    )
}

impl NetworkManager {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join("network.json"),
            state: NetworkState::default(),
            backend: crate::native::network_backend(),
        }
    }

    fn load(&mut self) -> Result<()> {
        match fs::symlink_metadata(&self.path) {
            Ok(info) => {
                crate::files::protected_info(&self.path, &info)?;
                let file = crate::files::checked_open(&self.path)?;
                let mut bytes = Vec::new();
                file.take((4 << 20) + 1).read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() <= 4 << 20,
                    "network recovery journal exceeds limit"
                );
                let state: NetworkState =
                    serde_json::from_slice(&bytes).context("invalid network recovery journal")?;
                ensure!(
                    state.entries.len() <= 4096,
                    "network journal has too many entries"
                );
                for entry in &state.entries {
                    ensure!(
                        valid_kind(&entry.kind)
                            && !entry.service.is_empty()
                            && entry.service.len() <= 4096,
                        "invalid network recovery entry"
                    );
                }
                self.state = state;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        crate::files::protected_ancestors(
            self.path
                .parent()
                .context("network journal has no parent")?,
        )?;
        if let Ok(info) = fs::symlink_metadata(&self.path) {
            crate::files::protected_info(&self.path, &info)?;
            ensure!(info.is_file(), "network journal is not a regular file");
        }
        write_json(&self.path, &self.state)
    }

    fn apply(&mut self, service: &str, kind: &str, value: NetworkValue) -> Result<()> {
        let before = self.backend.get(service, kind)?;
        let index = self
            .state
            .entries
            .iter()
            .position(|e| e.service == service && e.kind == kind);
        let index = if let Some(index) = index {
            ensure!(
                equivalent(kind, &before, &self.state.entries[index].applied),
                "network setting changed outside Clash Momo; disable and retry"
            );
            index
        } else {
            self.state.entries.push(NetworkEntry {
                service: service.into(),
                kind: kind.into(),
                before: before.clone(),
                applied: before.clone(),
                pending: vec![],
            });
            self.state.entries.len() - 1
        };
        self.state.entries[index].pending = vec![before.clone(), value.clone()];
        self.save()?;
        self.backend.set(service, kind, &before, &value)?;
        let verified = self.backend.get(service, kind)?;
        ensure!(
            equivalent(kind, &verified, &value),
            "network settings did not match requested values"
        );
        self.state.entries[index].applied = value;
        self.state.entries[index].pending.clear();
        self.save()
    }

    fn restore_kinds(&mut self, dns_only: Option<bool>) -> Result<()> {
        self.load()?;
        let mut remaining = Vec::new();
        let mut errors = Vec::new();
        for index in 0..self.state.entries.len() {
            let mut entry = self.state.entries[index].clone();
            if dns_only.is_some_and(|dns| dns != (entry.kind == "dnsservers")) {
                remaining.push(entry);
                continue;
            }
            let result = (|| -> Result<()> {
                let current = self.backend.get(&entry.service, &entry.kind)?;
                let ours = equivalent(&entry.kind, &current, &entry.applied)
                    || entry
                        .pending
                        .iter()
                        .any(|v| equivalent(&entry.kind, &current, v));
                if !ours {
                    return Ok(());
                }
                // Keep old Go intermediate states, and journal the native atomic transition.
                if !entry
                    .pending
                    .iter()
                    .any(|v| equivalent(&entry.kind, v, &current))
                {
                    entry.pending.push(current.clone());
                }
                if !entry
                    .pending
                    .iter()
                    .any(|v| equivalent(&entry.kind, v, &entry.before))
                {
                    entry.pending.push(entry.before.clone());
                }
                self.state.entries[index] = entry.clone();
                self.save()?;
                self.backend
                    .set(&entry.service, &entry.kind, &current, &entry.before)?;
                let verified = self.backend.get(&entry.service, &entry.kind)?;
                ensure!(
                    equivalent(&entry.kind, &verified, &entry.before),
                    "network restoration did not match saved values"
                );
                Ok(())
            })();
            if let Err(error) = result {
                remaining.push(entry);
                errors.push(error.to_string());
            }
        }
        self.state.entries = remaining;
        if let Err(error) = self.save() {
            errors.push(error.to_string());
        }
        ensure!(
            errors.is_empty(),
            "network restoration failed: {}",
            errors.join("; ")
        );
        Ok(())
    }

    pub fn restore(&mut self) -> Result<()> {
        self.restore_kinds(None)
    }

    pub fn proxy(&mut self, request: ProxyRequest) -> Result<()> {
        if !request.enabled {
            return self.restore_kinds(Some(false));
        }
        ensure!(
            matches!(request.mode.as_str(), "" | "manual" | "auto"),
            "invalid proxy mode"
        );
        if request.mode == "auto" {
            let url = url::Url::parse(&request.url).context("invalid PAC URL")?;
            // Url normalizes legacy numeric IPv4 spellings; require an actual IP literal.
            let authority = request
                .url
                .split_once("://")
                .map(|(_, value)| value.split(['/', '?', '#']).next().unwrap_or_default())
                .unwrap_or_default();
            let host = if let Some(ipv6) = authority.strip_prefix('[') {
                ipv6.split_once(']')
                    .map(|(host, _)| host)
                    .unwrap_or_default()
            } else {
                authority.split(':').next().unwrap_or_default()
            };
            let ip: IpAddr = host.parse().context("PAC must use a loopback HTTP URL")?;
            ensure!(
                url.scheme() == "http"
                    && ip.is_loopback()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && request.url.len() <= 2048
                    && !request.url.chars().any(char::is_control),
                "PAC must use a loopback HTTP URL"
            );
        } else {
            ensure!(
                matches!(request.host.as_str(), "127.0.0.1" | "::1" | "localhost"),
                "proxy must use a loopback host"
            );
            ensure!((1..=65535).contains(&request.port), "invalid proxy port");
        }
        ensure!(request.bypass.len() <= 256, "too many proxy bypass domains");
        for domain in &request.bypass {
            ensure!(
                domain.len() <= 255
                    && !domain.contains(['\r', '\n', '\0'])
                    && !domain.starts_with('-'),
                "invalid bypass domain"
            );
        }
        let services = self.backend.services()?;
        ensure!(!services.is_empty(), "no active network services");
        let result = (|| -> Result<()> {
            for service in services {
                for kind in [
                    "webproxy",
                    "securewebproxy",
                    "socksfirewallproxy",
                    "autoproxyurl",
                    "proxyautodiscovery",
                    "proxybypassdomains",
                ] {
                    let mut value = self.backend.get(&service, kind)?;
                    match kind {
                        "webproxy" | "securewebproxy" | "socksfirewallproxy" => {
                            value.enabled = request.mode != "auto";
                            if value.enabled {
                                value.host = request.host.clone();
                                value.port = request.port;
                            }
                        }
                        "autoproxyurl" => {
                            value.enabled = request.mode == "auto";
                            if value.enabled {
                                value.url = request.url.clone();
                            }
                        }
                        "proxyautodiscovery" => value.enabled = false,
                        "proxybypassdomains" => value.list = request.bypass.clone(),
                        _ => unreachable!(),
                    }
                    self.apply(&service, kind, value)?;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = self.restore_kinds(Some(false));
            return Err(error);
        }
        Ok(())
    }

    pub fn dns(&mut self, request: DnsRequest) -> Result<()> {
        if !request.enabled {
            return self.restore_kinds(Some(true));
        }
        ensure!(
            (1..=8).contains(&request.servers.len()),
            "DNS requires one to eight IP addresses"
        );
        for address in &request.servers {
            address.parse::<IpAddr>().context("invalid DNS IP")?;
        }
        let services = self.backend.services()?;
        ensure!(!services.is_empty(), "no active network services");
        for service in services {
            if let Err(error) = self.apply(
                &service,
                "dnsservers",
                NetworkValue {
                    list: request.servers.clone(),
                    ..NetworkValue::default()
                },
            ) {
                let _ = self.restore_kinds(Some(true));
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn status(&self) -> Value {
        json!({"proxy": self.state.entries.iter().any(|e| e.kind != "dnsservers"), "dns": self.state.entries.iter().any(|e| e.kind == "dnsservers")})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    #[derive(Default)]
    struct Fake {
        values: HashMap<String, NetworkValue>,
        fail: bool,
        calls: usize,
    }
    struct Backend(Arc<Mutex<Fake>>);
    impl NetworkBackend for Backend {
        fn services(&mut self) -> Result<Vec<String>> {
            Ok(vec!["Wi-Fi".into()])
        }
        fn get(&mut self, _: &str, kind: &str) -> Result<NetworkValue> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .values
                .get(kind)
                .cloned()
                .unwrap_or_default())
        }
        fn set(
            &mut self,
            _: &str,
            kind: &str,
            expected: &NetworkValue,
            value: &NetworkValue,
        ) -> Result<()> {
            let mut fake = self.0.lock().unwrap();
            fake.calls += 1;
            if fake.fail {
                anyhow::bail!("injected failure");
            }
            ensure!(
                equivalent(
                    kind,
                    fake.values.get(kind).unwrap_or(&NetworkValue::default()),
                    expected
                ),
                "external change"
            );
            fake.values.insert(kind.into(), value.clone());
            Ok(())
        }
    }
    fn manager(root: &Path, fake: &Arc<Mutex<Fake>>) -> NetworkManager {
        NetworkManager {
            path: root.join("network.json"),
            state: NetworkState::default(),
            backend: Box::new(Backend(fake.clone())),
        }
    }

    fn protected_root() -> Option<tempfile::TempDir> {
        if unsafe { libc::geteuid() } != 0 {
            return None;
        }
        for parent in ["/root", "/var/lib", "/Library/Application Support"] {
            if crate::files::protected_ancestors(Path::new(parent)).is_ok() {
                return tempfile::Builder::new()
                    .prefix("momo-network-test-")
                    .tempdir_in(parent)
                    .ok();
            }
        }
        None
    }

    #[test]
    fn go_journal_intermediate_recovery_and_external_ownership() {
        let Some(root) = protected_root() else {
            return;
        };
        let before = NetworkValue {
            host: "old".into(),
            port: 1234,
            ..Default::default()
        };
        let intermediate = NetworkValue {
            enabled: true,
            host: "127.0.0.1".into(),
            port: 7890,
            ..Default::default()
        };
        let fake = Arc::new(Mutex::new(Fake::default()));
        fake.lock()
            .unwrap()
            .values
            .insert("webproxy".into(), intermediate.clone());
        fs::write(root.path().join("network.json"), br#"{"entries":[{"service":"Wi-Fi","kind":"webproxy","before":{"enabled":false,"host":"old","port":1234},"applied":{"enabled":false,"host":"old","port":1234},"pending":[{"enabled":true,"host":"127.0.0.1","port":7890}]}]}"#).unwrap();
        let mut n = manager(root.path(), &fake);
        n.restore().unwrap();
        assert_eq!(fake.lock().unwrap().values["webproxy"], before);
        n.apply("Wi-Fi", "webproxy", intermediate).unwrap();
        let external = NetworkValue {
            enabled: true,
            host: "vpn".into(),
            port: 9999,
            ..Default::default()
        };
        fake.lock()
            .unwrap()
            .values
            .insert("webproxy".into(), external.clone());
        n.restore().unwrap();
        assert_eq!(fake.lock().unwrap().values["webproxy"], external);
        assert!(n.state.entries.is_empty());
    }

    #[test]
    fn failed_restore_keeps_durable_claim_and_empty_pac_compatibility() {
        let Some(root) = protected_root() else {
            return;
        };
        let fake = Arc::new(Mutex::new(Fake::default()));
        fake.lock().unwrap().values.insert(
            "autoproxyurl".into(),
            NetworkValue {
                url: "(null)".into(),
                ..Default::default()
            },
        );
        let mut n = manager(root.path(), &fake);
        n.apply(
            "Wi-Fi",
            "autoproxyurl",
            NetworkValue {
                enabled: true,
                url: "http://127.0.0.1/pac".into(),
                ..Default::default()
            },
        )
        .unwrap();
        fake.lock().unwrap().fail = true;
        assert!(n.restore().is_err());
        assert_eq!(n.state.entries.len(), 1);
        fake.lock().unwrap().fail = false;
        manager(root.path(), &fake).restore().unwrap();
        assert_eq!(fake.lock().unwrap().values["autoproxyurl"].url, "(null)");
        assert!(equivalent(
            "autoproxyurl",
            &NetworkValue::default(),
            &NetworkValue {
                url: "(null)".into(),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn go_null_lists_and_empty_journal_are_accepted() {
        let state: NetworkState = serde_json::from_str(r#"{"entries":null}"#).unwrap();
        assert!(state.entries.is_empty());
        let value: NetworkValue = serde_json::from_str(r#"{"enabled":false,"list":null}"#).unwrap();
        assert_eq!(value, NetworkValue::default());
    }

    #[test]
    fn journal_rejects_symlinks_hardlinks_and_untrusted_writers() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let Some(root) = protected_root() else {
            return;
        };
        let fake = Arc::new(Mutex::new(Fake::default()));
        let mut n = manager(root.path(), &fake);
        let original = root.path().join("original.json");
        let journal = root.path().join("network.json");
        fs::write(&original, br#"{"entries":[]}"#).unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&original, &journal).unwrap();
        assert!(n.restore().is_err());
        fs::remove_file(&journal).unwrap();
        fs::hard_link(&original, &journal).unwrap();
        assert!(n.restore().is_err());
        fs::remove_file(&journal).unwrap();
        fs::write(&journal, br#"{"entries":[]}"#).unwrap();
        fs::set_permissions(&journal, fs::Permissions::from_mode(0o622)).unwrap();
        assert!(n.restore().is_err());
        fs::set_permissions(&journal, fs::Permissions::from_mode(0o600)).unwrap();
        n.restore().unwrap();
        assert_eq!(fake.lock().unwrap().calls, 0);
    }

    #[test]
    fn proxy_dns_validation_fails_before_mutations() {
        let root = tempfile::tempdir().unwrap();
        let fake = Arc::new(Mutex::new(Fake::default()));
        let mut n = manager(root.path(), &fake);
        for host in ["example.com", "0.0.0.0", "127.0.0.2"] {
            assert!(
                n.proxy(ProxyRequest {
                    enabled: true,
                    host: host.into(),
                    port: 7890,
                    ..Default::default()
                })
                .is_err()
            );
        }
        for url in [
            "https://127.0.0.1/pac",
            "http://localhost/pac",
            "http://user@127.0.0.1/pac",
            "http://example.com/pac",
            "http://127.1/pac",
            "http://2130706433/pac",
        ] {
            assert!(
                n.proxy(ProxyRequest {
                    enabled: true,
                    mode: "auto".into(),
                    url: url.into(),
                    ..Default::default()
                })
                .is_err()
            );
        }
        assert!(
            n.dns(DnsRequest {
                enabled: true,
                servers: vec!["example.com".into()]
            })
            .is_err()
        );
        assert_eq!(fake.lock().unwrap().calls, 0);
    }
}
