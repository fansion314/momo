# Optional group subscription core

Normal distributed packages build this module enabled. Plain untagged Go builds
keep it disabled; source developers may use `-tags tizi` without a key to inspect
the capability. The desktop can disable the module independently.
A matching native core is mandatory; a normal core returns `supported:false`.
The module does not add a listener. The desktop uses the existing local core
control socket and the private native JSON bridge.

## Manual build

Keep `TIZI_BUILD_KEYS` in the private build's secret store. It is a comma-separated
key ring, newest first: `key-id:base64-of-32-random-bytes,previous-id:...`.
There is no source-code key, environment runtime fallback or public test default.

```sh
TIZI_REQUIRE_BUILD_KEYS=true bash packaging/build-core.sh ./mihomomo 1.19.33
```

The build helper reads the key ring from the environment and creates a private,
ignored Go initializer with mode0600. A trap removes it after success or failure.
The secret is never placed in Go linker flags or version metadata, source
archives or git. Release builds fail if the key is missing. Local source builds without an explicit
key generate and reuse an owner-only key at
`${XDG_DATA_HOME:-$HOME/.local/share}/mihomomo/build-keys`, or
`TIZI_BUILD_KEYS_FILE` when supplied. Keep that file across rebuilds and supply the
same key when building inside disposable chroots; changing it makes an existing
encrypted device state unreadable. Never upload it with source recipes.

The key ring is compiled into the native core, not the Electron renderer. Keep
old keys until all existing encrypted files have been rewritten. A client binary
owner can extract compiled secrets; this protects files from casual inspection
and modification, not from an adversary controlling the process.

## Desktop bridge

```text
mihomomo tizi --state-dir /absolute/private/path COMMAND
```

A JSON request is read from standard input, capped at 64 KiB. Standard output is
one JSON envelope: `{ok:true,data:...}` or
`{ok:false,error:{code,message}}`. Commands are `status`, `register`,
`registration-status`, `complete-registration`, `reset-request`, `reset-confirm`,
`login`, `logout`, `refresh`, `sync`, and `usage`. Commands never return raw YAML
or a device private key. Native secret fields must be sent over stdin, never argv.

The HTTP API uses device Ed25519 signatures, UUID replay nonces and SHA-256 body
hashes. Only HTTPS origins are accepted, except HTTP loopback for integration
fixtures. Redirects are forbidden and HTTP errors are sanitized.

Status returns `supported`, `keyReady`, `logged_in`, `managed_config_version: 2`,
account and device metadata,
`subscription` (Caddy's upload/download/total/expire), `health` (stable string),
`health_details`, `last_sync_at` and `pending_days` when available. Header counters
come from Caddy and remain separate from self-reported payload counters.

`refresh` downloads and validates a new encrypted snapshot; the desktop must
reload the managed configuration to apply it. `sync` queues work when the managed
core owns the ledger, otherwise sends completed days directly. Desktop startup,
resume and daily scheduling must call it even when a private profile is selected.
Explicit logout settles today's partial total before disabling managed use.

## Managed runtime and accounting

The application's on-disk runtime contains only `tizi-managed: {state-dir: ...}`
and a limited set of general network/history settings. The native parser expands
its encrypted inline subscription in memory. Proxy-provider caches, scripts,
server listeners and public/TLS controllers and external dashboards are forbidden.
The nested `tizi-managed.smart` policy accepts only `enabled`, `useLightGBM`,
`collectData` booleans and an integer `collectorSize` from 1 to 100000 (default100).
It transforms automatic groups in memory, preserves ordering and explicit rules,
and updates references without executing scripts. Safe DNS/hosts/sniffer and
Geo/LGBM settings follow the client controls. Final disabled or missing DNS
clears TUN DNS hijacking; Smart adds literal node IP route exclusions only inside
the core. None of these transformations rewrites the encrypted subscription.
Applications must require managed configuration version2 before enabling the
new structured policy, including the core copied into the privileged helper.
Control-plane HTTP uses the core's existing real-IP proxy-host resolver and
socket binding; standalone native commands use the existing system resolver
before proxy DNS is initialized, with no new DNS-server overrides.
The core operates with local Unix/pipe control only. Managed root helpers must
use the fixed sibling `tizi` state directory outside imported snapshots and run
bridge commands through the authenticated helper; do not copy the ledger.

Each connection captures its managed owner, and only concrete network adapters
are counted. DIRECT aliases and internal layers are excluded. Every actual byte
counter path feeds the independent ledger, which does not depend on detailed
history being enabled. Dates start at 07:00 Asia/Shanghai. Payload-byte accounting
can differ from airport traffic billing, which includes protocol overhead.

Identity, subscription and daily ledger files are AES-GCM authenticated with
random nonces and salts, atomically replaced with mode 0600. Counter updates do
not do disk or network I/O. The writer checkpoints every second and marks an
unclean shutdown incomplete; the uncheckpointed tail cannot be reconstructed.
On storage failure, affected proxy connections are closed. Missing/corrupt
established ledgers are never reset automatically. A restored old encrypted
ledger is rejected by the server's monotonic receipts when it next connects.
Normal network outages retain the last working configuration without expiry.

## Tests

```sh
go test -race -tags tizi ./component/tizi ./tunnel/statistic ./config ./hub/route
go test ./component/tizi ./tunnel/statistic ./config ./hub/route
```
