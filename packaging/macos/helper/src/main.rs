mod dirfd;
mod files;
mod install;
mod native;
mod network;
mod process;
mod server;
mod snapshot;

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::path::Path;

const LABEL: &str = "world.fansionia.clash-momo.helper";
const ROOT: &str = "/Library/Application Support/world.fansionia.clash-momo";
const HELPER_PATH: &str = "/Library/PrivilegedHelperTools/world.fansionia.clash-momo.helper";
const PLIST_PATH: &str = "/Library/LaunchDaemons/world.fansionia.clash-momo.helper.plist";
const SOCKET_DIR: &str = "/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc";
const SOCKET: &str = "/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc/helper.sock";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    uid: u32,
    helper_hash: String,
    core_hash: String,
    core_version: String,
}

fn main() {
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(8)
        .build()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| runtime.block_on(run()));
    if let Err(error) = result {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["version"] {
        println!("2");
        return Ok(());
    }
    if args == ["status"] {
        return server::print_status().await;
    }
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "administrator authorization required"
    );
    match args.first().map(String::as_str) {
        Some("serve") if args.len() == 1 => server::serve().await,
        Some("uninstall") if args.len() == 1 => install::uninstall(),
        Some("install") if args.len() == 5 => {
            let mut uid = None;
            let mut core = None;
            for pair in args[1..].as_chunks::<2>().0 {
                match pair[0].as_str() {
                    "--uid" if uid.is_none() => uid = Some(pair[1].parse::<u32>()?),
                    "--core" if core.is_none() => core = Some(pair[1].as_str()),
                    _ => bail!("invalid install arguments"),
                }
            }
            install::install(
                uid.ok_or_else(|| anyhow::anyhow!("UID required"))?,
                Path::new(core.ok_or_else(|| anyhow::anyhow!("core required"))?),
            )
        }
        _ => bail!("expected install --uid UID --core PATH, serve, uninstall, status, or version"),
    }
}
