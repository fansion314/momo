# macOS privileged core helper

This is a deliberately small launchd service for Clash Momo. It owns one protected
Mihomomo process and restores only the proxy/DNS values that it still owns. The
Electron application stays an ordinary user process. Developer ID signing is not
required for this explicit administrator-authorized installation flow.

The build resource is `files/world.fansionia.clash-momo.helper`. Build natively on
macOS with cgo enabled (the Darwin adapter uses `getpeereid` and `libproc`):

```sh
go build -trimpath -o world.fansionia.clash-momo.helper .
```

Do not run an installation on a developer machine merely to build or test it.
Linux `go test -race ./...` covers protocol, filesystem, journal and lifecycle
logic in the existing Arch development container. macOS disposable CI additionally
builds/installs the actual service and verifies UID isolation and managed-core IPC.

## Administrator commands

```sh
world.fansionia.clash-momo.helper install --uid 501 --core /opt/homebrew/opt/mihomomo/bin/mihomomo
world.fansionia.clash-momo.helper uninstall
```

Electron invokes these with `osascript` administrator authorization. Installation
discovers the helper's own executable, copies both executables into root-only
staging, probes **the protected core copy**, and records their SHA-256 hashes. Root
never executes the Homebrew/user-writable core path. Every install or binary update
requires authorization again. Replacement stops the old service, atomically swaps
each protected file, bootstraps launchd, then probes the socket as the bound UID.
Failures restore old binaries/configuration and bootstrap the old service. This is
an application-level rollback across individually atomic file replacements; a
power interruption during installation may require running the authorized install
again. Existing managed data is retained.

The service label is `world.fansionia.clash-momo.helper`. Its executable lives at
`/Library/PrivilegedHelperTools/world.fansionia.clash-momo.helper`, its launchd plist
at `/Library/LaunchDaemons/world.fansionia.clash-momo.helper.plist`, and its protected
state at `/Library/Application Support/world.fansionia.clash-momo`. The stable
managed working directory is that state's `data/` directory, mode 0700. The public
socket is `/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc/helper.sock`.
This keeps all ancestors root-owned and without group/world writers; macOS's
group-writable `/private/var/run` is intentionally avoided. The root-owned socket
directory is mode 0711, and the socket belongs only
to the bound application UID, mode 0600. Each accepted connection independently
checks its peer UID with `getpeereid`.

Uninstall stops the launchd service and its managed core, recovers any journaled
process/network state, and removes the launchd plist, helper and public socket.
Protected core, data, migration marker, import manifest and logs remain for recovery.
The application stops the core and exports supported DB state before uninstalling
to hand the latest history back to its ordinary working directory.

## Protocol 1

HTTP runs exclusively over the Unix socket. No TCP listener, CORS, shell command,
arbitrary executable, arbitrary environment, arbitrary PID or arbitrary root path
API is exposed. Requests with an Origin header are rejected.

| Method and path          | Body / result                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/status`         | `protocol`, `helperVersion`, `coreVersion`, `helperHash`, `coreHash`, `running`, `pid`, `workDir`, `uid`, `dataMigrated` |
| `POST /v1/session`       | Returns `{token}`; rejects replacement of a live session with 409                                                        |
| `POST /v1/lease`         | Returns `{ok:true,running}`; renew every 2 seconds                                                                       |
| `POST /v1/core/start`    | Snapshot, starts the sole managed core                                                                                   |
| `POST /v1/core/config`   | Snapshot, validates then reloads; restarts for changed age key                                                           |
| `POST /v1/core/stop`     | Stops core and restores owned network settings                                                                           |
| `GET /v1/core/logs`      | `{logs}`: latest at most 1 MiB, persistent log bounded to 4 MiB                                                          |
| `GET /v1/core/state`     | Stopped-core export `{files:[{path,data}]}`, allowlisted history/cache DB + WAL/SHM only, 512 MiB total                  |
| `POST /v1/network/proxy` | `{enabled,mode:'manual',host,port,bypass}` or `{enabled,mode:'auto',url,bypass}`                                         |
| `POST /v1/network/dns`   | `{enabled,servers:[IP,...]}`                                                                                             |
| `GET /v1/network/status` | `{proxy:boolean,dns:boolean}`                                                                                            |
| `/core/*`                | Restricted HTTP and WebSocket proxy to the private root-only kernel socket                                               |

Every operation after status/session requires `X-Momo-Session`. Tokens contain 256
random bits, expire after 10 seconds without renewal, and are never persisted. Lease
renewals use a separate mutex so large snapshots cannot starve them. Expiry stops
the core (SIGINT, up to 6 seconds, then SIGKILL) and restores owned network settings.
Process recovery compares PID **and** kernel process start identity/executable before
signaling a previous process. A new session cannot be stopped by an older expiry.

A snapshot is `{config:string,files:[{path:string,data:base64,importOnly?:boolean}],ageSecretKey?:string}`.
Paths are normalized relative paths only. Existing symlinks, regular hard links,
non-root owners and group/world writers anywhere in the protected tree are rejected.
Configuration is bounded to 16 MiB, JSON to 768 MiB, decoded files to 576 MiB total
and 512 MiB per file, and count to 20,000. `importOnly` never overwrites existing
state. Other files use a protected source-digest manifest: unchanged client sources
preserve newer kernel downloads; a changed client source deliberately replaces the
asset. Staging and validation failures restore the previous files. The age key is
passed only in the child's `CLASH_AGE_SECRET_KEY`, never arbitrary environment keys.

The child always receives `--momo-managed`, fixed protected `-d`/`-f` paths and a
private controller socket. The managed kernel independently restricts dangerous
configuration fields, paths and API operations. The helper denies restart, upgrade,
external UI installation and direct full config reload. The application must use
the snapshot endpoint for full reload. Proxy targets are fixed to the managed Unix
socket, and unknown API routes are denied.

Proxy hosts must be loopback and PAC URLs must be HTTP loopback IP URLs. DNS accepts
literal IPs only. The helper enumerates enabled network services and persists the
original values **before** each mutation. Because `networksetup` changes proxy
content and enabled state in separate commands, the journal records all exact
intermediate states before running either command. Restoration also journals its
intermediates, verifies restored values, and retains failed entries for retry. A
setting changed by another application is preserved and our claim is dropped.
Authenticated system proxies are rejected because networksetup does not expose
their credentials for exact restoration.
Originally absent PAC URLs and HTTP/HTTPS/SOCKS addresses are cleared through scoped
SystemConfiguration transactions, removing only the selected service's fixed
address fields and preserving enabled flags and unrelated proxy settings. They are
never restored by passing guessed empty URL/host/port arguments to networksetup.

## Deliberate trust boundary

This service binds authorization to a local UID, not a cryptographically signed
application identity. Other processes running as that same user can connect and
obtain a session while none is active. The managed kernel's configuration/path/API
restrictions are therefore security boundaries, not just UI validation. An approved
core/helper binary itself is trusted root code; authorizing replacement explicitly
approves those bytes. There is no silent self-update of protected executables.

Real TUN packet flow, sleep/wake, interface switching, administrator cancellation,
physical DNS/proxy behavior and crash recovery on macOS require device acceptance
in addition to the automated tests. No developer-machine installation is performed
by the test suite.
