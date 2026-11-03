use crate::network::{NetworkBackend, NetworkValue};
#[cfg(target_os = "linux")]
use anyhow::Context;
use anyhow::{Result, bail, ensure};
use std::os::fd::RawFd;

pub fn peer_uid(fd: RawFd) -> Result<u32> {
    #[cfg(target_os = "macos")]
    {
        let (mut uid, mut gid) = (0, 0);
        // getpeereid reads kernel credentials for this already accepted descriptor.
        ensure!(
            unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } == 0,
            "cannot determine socket peer UID"
        );
        Ok(uid)
    }
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
        ensure!(
            unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut size,
                )
            } == 0
                && size as usize == std::mem::size_of_val(&credentials),
            "cannot determine socket peer UID"
        );
        Ok(credentials.uid)
    }
}

pub fn process_identity(pid: i32) -> Result<String> {
    ensure!(pid > 1, "invalid process PID");
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info);
        ensure!(
            unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size as i32,
                )
            } == size as i32,
            "cannot determine process start identity"
        );
        let mut path = vec![0u8; 4096];
        let length =
            unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        ensure!(
            length > 0 && (length as usize) < path.len(),
            "cannot determine process executable"
        );
        path.truncate(length as usize);
        if path.last() == Some(&0) {
            path.pop();
        }
        Ok(format!(
            "{}:{}:{}",
            info.pbi_start_tvsec,
            info.pbi_start_tvusec,
            std::str::from_utf8(&path)?
        ))
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let (_, fields) = stat.rsplit_once(") ").context("invalid process stat")?;
        let start = fields
            .split_whitespace()
            .nth(19)
            .context("invalid process stat")?;
        let executable = std::fs::read_link(format!("/proc/{pid}/exe"))?;
        Ok(format!(
            "{start}:{}",
            executable.to_str().context("non-UTF8 executable path")?
        ))
    }
}

pub(crate) fn network_backend() -> Box<dyn NetworkBackend> {
    Box::new(NativeNetwork)
}
struct NativeNetwork;

#[cfg(not(target_os = "macos"))]
impl NetworkBackend for NativeNetwork {
    fn services(&mut self) -> Result<Vec<String>> {
        bail!("native network configuration requires macOS")
    }
    fn get(&mut self, _: &str, _: &str) -> Result<NetworkValue> {
        bail!("native network configuration requires macOS")
    }
    fn set(&mut self, _: &str, _: &str, _: &NetworkValue, _: &NetworkValue) -> Result<()> {
        bail!("native network configuration requires macOS")
    }
}

#[cfg(target_os = "macos")]
mod sc {
    use super::*;
    use std::{
        ffi::{CString, c_void},
        ptr,
    };

    type Cf = *const c_void;
    type MutableCf = *mut c_void;
    const UTF8: u32 = 0x0800_0100;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: Cf);
        fn CFGetTypeID(value: Cf) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: Cf) -> u8;
        fn CFStringCreateWithCString(
            allocator: Cf,
            value: *const libc::c_char,
            encoding: u32,
        ) -> Cf;
        fn CFStringGetLength(value: Cf) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            value: Cf,
            buffer: *mut libc::c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFArrayGetCount(value: Cf) -> isize;
        fn CFArrayGetValueAtIndex(value: Cf, index: isize) -> Cf;
        fn CFArrayCreateMutable(
            allocator: Cf,
            capacity: isize,
            callbacks: *const c_void,
        ) -> MutableCf;
        fn CFArrayAppendValue(array: MutableCf, value: Cf);
        fn CFDictionaryGetValue(dictionary: Cf, key: Cf) -> Cf;
        fn CFDictionaryCreateMutable(
            allocator: Cf,
            capacity: isize,
            keys: *const c_void,
            values: *const c_void,
        ) -> MutableCf;
        fn CFDictionaryCreateMutableCopy(
            allocator: Cf,
            capacity: isize,
            dictionary: Cf,
        ) -> MutableCf;
        fn CFDictionarySetValue(dictionary: MutableCf, key: Cf, value: Cf);
        fn CFDictionaryRemoveValue(dictionary: MutableCf, key: Cf);
        fn CFNumberCreate(allocator: Cf, kind: i32, value: *const c_void) -> Cf;
        fn CFNumberGetValue(number: Cf, kind: i32, value: *mut c_void) -> u8;
        static kCFTypeArrayCallBacks: u8;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
    }
    #[link(name = "SystemConfiguration", kind = "framework")]
    unsafe extern "C" {
        fn SCPreferencesCreate(allocator: Cf, name: Cf, prefs_id: Cf) -> Cf;
        fn SCPreferencesLock(preferences: Cf, wait: u8) -> u8;
        fn SCPreferencesUnlock(preferences: Cf) -> u8;
        fn SCPreferencesCommitChanges(preferences: Cf) -> u8;
        fn SCPreferencesApplyChanges(preferences: Cf) -> u8;
        fn SCNetworkServiceCopyAll(preferences: Cf) -> Cf;
        fn SCNetworkServiceGetName(service: Cf) -> Cf;
        fn SCNetworkServiceGetEnabled(service: Cf) -> u8;
        fn SCNetworkServiceCopyProtocol(service: Cf, kind: Cf) -> Cf;
        fn SCNetworkProtocolGetConfiguration(protocol: Cf) -> Cf;
        fn SCNetworkProtocolSetConfiguration(protocol: Cf, configuration: Cf) -> u8;
    }

    struct Owned(Cf);
    impl Owned {
        fn new(value: Cf) -> Result<Self> {
            ensure!(!value.is_null(), "SystemConfiguration allocation failed");
            Ok(Self(value))
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }
    struct Preferences {
        value: Owned,
        locked: bool,
    }
    impl Drop for Preferences {
        fn drop(&mut self) {
            if self.locked {
                unsafe { SCPreferencesUnlock(self.value.0) };
            }
        }
    }

    fn string(value: &str) -> Result<Owned> {
        let value = CString::new(value)?;
        Owned::new(unsafe { CFStringCreateWithCString(ptr::null(), value.as_ptr(), UTF8) })
    }
    fn text(value: Cf) -> Result<String> {
        if value.is_null() {
            return Ok(String::new());
        }
        ensure!(
            unsafe { CFGetTypeID(value) == CFStringGetTypeID() },
            "expected SystemConfiguration string"
        );
        let length = unsafe { CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), UTF8) };
        ensure!(
            (0..=(1 << 20)).contains(&length),
            "SystemConfiguration string exceeds limit"
        );
        let mut bytes = vec![0u8; length as usize + 1];
        ensure!(
            unsafe {
                CFStringGetCString(value, bytes.as_mut_ptr().cast(), bytes.len() as isize, UTF8)
            } != 0,
            "invalid SystemConfiguration string"
        );
        bytes.truncate(bytes.iter().position(|v| *v == 0).unwrap_or(bytes.len()));
        Ok(String::from_utf8(bytes)?)
    }
    fn get(dictionary: Cf, key: &str) -> Result<Cf> {
        if dictionary.is_null() {
            return Ok(ptr::null());
        }
        let key = string(key)?;
        Ok(unsafe { CFDictionaryGetValue(dictionary, key.0) })
    }
    fn number(value: Cf) -> Result<i64> {
        if value.is_null() {
            return Ok(0);
        }
        if unsafe { CFGetTypeID(value) == CFBooleanGetTypeID() } {
            return Ok(unsafe { CFBooleanGetValue(value) } as i64);
        }
        ensure!(
            unsafe { CFGetTypeID(value) == CFNumberGetTypeID() },
            "expected SystemConfiguration number"
        );
        let mut number = 0i64;
        ensure!(
            unsafe { CFNumberGetValue(value, 4, (&mut number as *mut i64).cast()) } != 0,
            "invalid SystemConfiguration number"
        );
        Ok(number)
    }
    fn list(value: Cf) -> Result<Vec<String>> {
        if value.is_null() {
            return Ok(vec![]);
        }
        ensure!(
            unsafe { CFGetTypeID(value) == CFArrayGetTypeID() },
            "expected SystemConfiguration array"
        );
        let count = unsafe { CFArrayGetCount(value) };
        ensure!(
            (0..=4096).contains(&count),
            "SystemConfiguration array exceeds limit"
        );
        (0..count)
            .map(|i| text(unsafe { CFArrayGetValueAtIndex(value, i) }))
            .collect()
    }
    fn preferences(write: bool) -> Result<Preferences> {
        let label = string("world.fansionia.clash-momo.helper")?;
        let value = Owned::new(unsafe { SCPreferencesCreate(ptr::null(), label.0, ptr::null()) })?;
        if write {
            ensure!(
                unsafe { SCPreferencesLock(value.0, 0) } != 0,
                "network preferences are locked by another application"
            );
        }
        Ok(Preferences {
            value,
            locked: write,
        })
    }
    fn services(prefs: &Preferences) -> Result<Owned> {
        Owned::new(unsafe { SCNetworkServiceCopyAll(prefs.value.0) })
    }
    fn with_protocol<T>(
        service: &str,
        kind: &str,
        write: bool,
        operation: impl FnOnce(&Preferences, Cf, Cf) -> Result<T>,
    ) -> Result<T> {
        let prefs = preferences(write)?;
        let services = services(&prefs)?;
        let count = unsafe { CFArrayGetCount(services.0) };
        ensure!((0..=4096).contains(&count), "too many network services");
        let mut found: Cf = ptr::null();
        for index in 0..count {
            let item = unsafe { CFArrayGetValueAtIndex(services.0, index) };
            if text(unsafe { SCNetworkServiceGetName(item) })? == service {
                ensure!(found.is_null(), "ambiguous network service name");
                found = item;
            }
        }
        ensure!(!found.is_null(), "saved network service is unavailable");
        let protocol_kind = string(if kind == "dnsservers" {
            "DNS"
        } else {
            "Proxies"
        })?;
        let protocol = Owned::new(unsafe { SCNetworkServiceCopyProtocol(found, protocol_kind.0) })?;
        let config = unsafe { SCNetworkProtocolGetConfiguration(protocol.0) };
        operation(&prefs, protocol.0, config)
    }
    fn prefix(kind: &str) -> Result<&'static str> {
        match kind {
            "webproxy" => Ok("HTTP"),
            "securewebproxy" => Ok("HTTPS"),
            "socksfirewallproxy" => Ok("SOCKS"),
            _ => bail!("invalid proxy kind"),
        }
    }
    fn read_value(config: Cf, kind: &str) -> Result<NetworkValue> {
        let mut value = NetworkValue::default();
        match kind {
            "webproxy" | "securewebproxy" | "socksfirewallproxy" => {
                let prefix = prefix(kind)?;
                // Authentication secrets can live in Keychain; do not take ownership of authenticated proxies.
                for suffix in [
                    "User",
                    "ProxyAuthenticated",
                    "ProxyUsername",
                    "ProxyPassword",
                ] {
                    let field = get(config, &format!("{prefix}{suffix}"))?;
                    if !field.is_null() {
                        let present = if unsafe { CFGetTypeID(field) == CFStringGetTypeID() } {
                            !text(field)?.is_empty()
                        } else {
                            number(field)? != 0
                        };
                        ensure!(
                            !present,
                            "authenticated system proxies cannot be managed safely"
                        );
                    }
                }
                value.enabled = number(get(config, &format!("{prefix}Enable"))?)? != 0;
                value.host = text(get(config, &format!("{prefix}Proxy"))?)?;
                if value.host == "(null)" {
                    value.host.clear();
                }
                value.port = number(get(config, &format!("{prefix}Port"))?)?;
            }
            "autoproxyurl" => {
                value.enabled = number(get(config, "ProxyAutoConfigEnable")?)? != 0;
                value.url = text(get(config, "ProxyAutoConfigURLString")?)?;
                if value.url.is_empty() {
                    value.url = "(null)".into();
                }
            }
            "proxyautodiscovery" => {
                value.enabled = number(get(config, "ProxyAutoDiscoveryEnable")?)? != 0
            }
            "proxybypassdomains" => value.list = list(get(config, "ExceptionsList")?)?,
            "dnsservers" => value.list = list(get(config, "ServerAddresses")?)?,
            _ => bail!("invalid network setting kind"),
        }
        Ok(value)
    }
    fn set_field(config: MutableCf, key: &str, value: Option<&Owned>) -> Result<()> {
        let key = string(key)?;
        if let Some(value) = value {
            unsafe { CFDictionarySetValue(config, key.0, value.0) };
        } else {
            unsafe { CFDictionaryRemoveValue(config, key.0) };
        }
        Ok(())
    }
    fn set_number(config: MutableCf, key: &str, value: i64) -> Result<()> {
        let number =
            Owned::new(unsafe { CFNumberCreate(ptr::null(), 4, (&value as *const i64).cast()) })?;
        set_field(config, key, Some(&number))
    }
    fn set_text(config: MutableCf, key: &str, value: &str) -> Result<()> {
        if value.is_empty() || value == "(null)" {
            set_field(config, key, None)
        } else {
            set_field(config, key, Some(&string(value)?))
        }
    }
    fn set_list(config: MutableCf, key: &str, values: &[String]) -> Result<()> {
        if values.is_empty() {
            return set_field(config, key, None);
        }
        let array = Owned::new(unsafe {
            CFArrayCreateMutable(ptr::null(), 0, ptr::addr_of!(kCFTypeArrayCallBacks).cast())
        })?;
        for value in values {
            let value = string(value)?;
            unsafe { CFArrayAppendValue(array.0.cast_mut(), value.0) };
        }
        set_field(config, key, Some(&array))
    }
    fn write_value(config: MutableCf, kind: &str, value: &NetworkValue) -> Result<()> {
        match kind {
            "webproxy" | "securewebproxy" | "socksfirewallproxy" => {
                let prefix = prefix(kind)?;
                set_number(config, &format!("{prefix}Enable"), i64::from(value.enabled))?;
                set_text(config, &format!("{prefix}Proxy"), &value.host)?;
                if value.host.is_empty() && value.port == 0 {
                    set_field(config, &format!("{prefix}Port"), None)?;
                } else {
                    set_number(config, &format!("{prefix}Port"), value.port)?;
                }
            }
            "autoproxyurl" => {
                set_number(config, "ProxyAutoConfigEnable", i64::from(value.enabled))?;
                set_text(config, "ProxyAutoConfigURLString", &value.url)?;
            }
            "proxyautodiscovery" => {
                set_number(config, "ProxyAutoDiscoveryEnable", i64::from(value.enabled))?
            }
            "proxybypassdomains" => set_list(config, "ExceptionsList", &value.list)?,
            "dnsservers" => set_list(config, "ServerAddresses", &value.list)?,
            _ => bail!("invalid network setting kind"),
        }
        Ok(())
    }

    impl NetworkBackend for NativeNetwork {
        fn services(&mut self) -> Result<Vec<String>> {
            let prefs = preferences(false)?;
            let services = services(&prefs)?;
            let count = unsafe { CFArrayGetCount(services.0) };
            ensure!((0..=4096).contains(&count), "too many network services");
            let mut result = Vec::new();
            for index in 0..count {
                let service = unsafe { CFArrayGetValueAtIndex(services.0, index) };
                if unsafe { SCNetworkServiceGetEnabled(service) } != 0 {
                    let name = text(unsafe { SCNetworkServiceGetName(service) })?;
                    ensure!(!name.is_empty(), "invalid network service name");
                    result.push(name);
                }
            }
            Ok(result)
        }
        fn get(&mut self, service: &str, kind: &str) -> Result<NetworkValue> {
            with_protocol(service, kind, false, |_, _, config| {
                read_value(config, kind)
            })
        }
        fn set(
            &mut self,
            service: &str,
            kind: &str,
            expected: &NetworkValue,
            value: &NetworkValue,
        ) -> Result<()> {
            with_protocol(service, kind, true, |prefs, protocol, config| {
                let current = read_value(config, kind)?;
                ensure!(
                    crate::network::equivalent(kind, &current, expected),
                    "network setting changed before commit; preserving external change"
                );
                if crate::network::equivalent(kind, &current, value) {
                    return Ok(());
                }
                let copy = if config.is_null() {
                    Owned::new(unsafe {
                        CFDictionaryCreateMutable(
                            ptr::null(),
                            0,
                            ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
                            ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
                        )
                    })?
                } else {
                    Owned::new(unsafe { CFDictionaryCreateMutableCopy(ptr::null(), 0, config) })?
                };
                write_value(copy.0.cast_mut(), kind, value)?;
                ensure!(
                    unsafe { SCNetworkProtocolSetConfiguration(protocol, copy.0) } != 0,
                    "cannot stage network settings"
                );
                ensure!(
                    unsafe { SCPreferencesCommitChanges(prefs.value.0) } != 0,
                    "cannot commit network settings"
                );
                ensure!(
                    unsafe { SCPreferencesApplyChanges(prefs.value.0) } != 0,
                    "cannot apply network settings"
                );
                Ok(())
            })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn native_scoped_proxy_dns_roundtrip() -> Result<()> {
            const SERVICE: &str = "Clash Momo CI PAC Test";
            if std::env::var("MOMO_HELPER_TEST_NETWORK_SERVICE").as_deref() != Ok(SERVICE) {
                return Ok(());
            }
            ensure!(
                unsafe { libc::geteuid() } == 0,
                "explicit native network test requires root"
            );
            let prefs = preferences(false)?;
            let all = services(&prefs)?;
            let mut disabled = false;
            for index in 0..unsafe { CFArrayGetCount(all.0) } {
                let service = unsafe { CFArrayGetValueAtIndex(all.0, index) };
                if text(unsafe { SCNetworkServiceGetName(service) })? == SERVICE {
                    disabled = unsafe { SCNetworkServiceGetEnabled(service) } == 0;
                }
            }
            ensure!(
                disabled,
                "reserved CI service must exist and remain disabled"
            );
            drop(all);
            drop(prefs);
            let mut backend = NativeNetwork;
            for kind in [
                "webproxy",
                "securewebproxy",
                "socksfirewallproxy",
                "autoproxyurl",
                "proxyautodiscovery",
                "proxybypassdomains",
                "dnsservers",
            ] {
                let before = backend.get(SERVICE, kind)?;
                let other_kind =
                    if matches!(kind, "webproxy" | "securewebproxy" | "socksfirewallproxy") {
                        "autoproxyurl"
                    } else {
                        "webproxy"
                    };
                let unrelated = backend.get(SERVICE, other_kind)?;
                let value = match kind {
                    "webproxy" | "securewebproxy" | "socksfirewallproxy" => NetworkValue {
                        enabled: false,
                        host: "127.0.0.1".into(),
                        port: 17893,
                        ..Default::default()
                    },
                    "autoproxyurl" => NetworkValue {
                        enabled: false,
                        url: "http://127.0.0.1:17892/proxy.pac".into(),
                        ..Default::default()
                    },
                    "proxyautodiscovery" => NetworkValue {
                        enabled: true,
                        ..Default::default()
                    },
                    _ => NetworkValue {
                        list: vec![if kind == "dnsservers" {
                            "127.0.0.1".into()
                        } else {
                            "localhost".into()
                        }],
                        ..Default::default()
                    },
                };
                backend.set(SERVICE, kind, &before, &value)?;
                let set = backend.get(SERVICE, kind)?;
                ensure!(
                    crate::network::equivalent(kind, &set, &value),
                    "native setting differs"
                );
                let external = NetworkValue {
                    enabled: !value.enabled,
                    ..value.clone()
                };
                ensure!(
                    backend.set(SERVICE, kind, &external, &before).is_err(),
                    "native commit ignored stale expected state"
                );
                backend.set(SERVICE, kind, &set, &before)?;
                ensure!(
                    crate::network::equivalent(kind, &backend.get(SERVICE, kind)?, &before),
                    "native restore differs"
                );
                ensure!(
                    backend.get(SERVICE, other_kind)? == unrelated,
                    "native operation changed unrelated settings"
                );
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::fd::AsRawFd, os::unix::net::UnixStream};
    #[test]
    fn peer_and_process_identity_use_kernel_state() {
        let (a, _) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(a.as_raw_fd()).unwrap(), unsafe { libc::geteuid() });
        let first = process_identity(std::process::id() as i32).unwrap();
        assert_eq!(process_identity(std::process::id() as i32).unwrap(), first);
        assert!(first.contains(':'));
        assert!(process_identity(1).is_err());
    }
}
