# Traffic history

Mihomomo supports Go 1.26+ and its maintained release target is Arch Linux x86_64.
SQLite is built in using a pure Go driver; CGO is not required. Recording is
disabled by default and never changes the TCP/UDP read/write counters.

## Configuration

```yaml
traffic-history:
  enable: true
  path: traffic-history.db
  sample-interval: 30s
  flush-interval: 1s
  batch-size: 512
  queue-size: 8192
  max-pending-bytes: 33554432
  retention-days: 30
  shutdown-timeout: 5s
  geoip:
    enable: true
    country-path: ""
    city-path: ""
    asn-path: ""
```

Paths are relative to Mihomo's home directory and obey its safe-path policy.
Country/ASN paths default to the existing local Mihomo MMDB paths. City lookup
requires a City MMDB. Files are opened independently and never downloaded.
Missing or unsupported information remains `UNKNOWN`; private IPs use `LOCAL`.
The database must use a local filesystem path; Windows UNC/device paths are
rejected. Windows drive paths and filenames containing spaces or `#` are supported.
Available country, country name, continent, city, ASN and organization are saved
on the connection; raw tracker GeoIP/ASN metadata is also preserved.

The queue and memory budget bound admitted records, including the writer's
pending batch. The budget is an estimate of owned record storage, not a total
process RSS limit: channel storage, SQLite caches, query results and GeoIP readers
also consume memory. A full queue discards new final records instead of waiting.
Database work, JSON encoding and GeoIP lookup run in the writer. Disk errors use
bounded retries with 1–30 second backoff. Check `/traffic-history/status` for
discarded records, skipped samples, write errors and GeoIP warnings.

Configuration reload is idempotent. Changed recording settings end the old
recording session and create a new one. Existing connections establish a new
baseline; traffic before enabling or during a recording gap is not backfilled.
For a preexisting connection the baseline is its **first successful observation**,
not an instantaneous snapshot at enable time. Its `baselineAtMs` makes this
boundary explicit; bytes before that observation (including bytes transferred
after enable but before the first observation) are excluded. A preexisting
connection first seen at close can therefore have zero recorded session bytes.
Stopping waits up to `shutdown-timeout` to sample active connections and drain
the queue. Failure to initialize the recorder does not stop the proxy.

`retention-days: 0` disables automatic deletion. Otherwise, expired samples are
scheduled for deletion at startup and every hour. Small batches run between
normal flushes and continue on subsequent flushes until the backlog is drained;
busy or slow storage can delay cleanup. Terminal connection metadata without
remaining samples is removed after its `stateAtMs` ages out, including connections
whose disappearance was only observed later; active checkpoints remain. No full
VACUUM runs during recording. Retention limits history age, not database file
size; deleted pages can be reused. One recording process must own each database
path. Keep the database on a local filesystem and include its WAL when backing
up an open database, or use SQLite's backup facilities.

## Accounting semantics

- `flows` retains tracker identity, lifecycle, raw metadata, rule/payload,
  ordered proxy/provider chains and query dimensions. Arrays are JSON, not CSV.
- `samples` contains timestamped byte deltas and previous observation times.
  Cumulative checkpoints and deltas commit in one transaction; retries cannot
  double count. Idle checkpoints do not create repeated zero-byte rows.
- `sessions` records recording boundaries and completion/loss metrics. Schema v2
  upgrades v1 transactionally, preserving record IDs and counters. IDs are never
  reused after cleanup, keeping pagination and historical references stable.
- Normal use queries exclude trackers with `pushToManager=false`, matching the
  existing global traffic accounting and avoiding counting internal layers twice.
  Their detail is retained and can be included explicitly.
- The tracker's `UploadTotal`/`DownloadTotal` counters are represented by
  `uploadTotal`/`downloadTotal` columns on a flow (the SQL-to-JSON names below use
  camel case). `baselineUpload`/`baselineDownload` exclude preexisting traffic;
  `recordedUpload`/`recordedDownload` count after the flow's `baselineAtMs`, including data
  subsequently expired from the sample table. Range aggregates use samples only.
- `connections` counts a newly observed connection once, including zero-byte
  connections. Preexisting connections have no new-connection increment.
  `participatingConnections` counts distinct recorded flows in the selected
  samples. Sampling never increments connection count repeatedly.
- Deltas belong to the observation timestamp, **not** to an assumed uniform
  distribution of bytes over the interval. Long connections are split into
  periodic observations, but exact cross-minute/day byte attribution is unknown.
- A UDP tracker is a reused session and can carry multiple destinations. Its
  counters remain attributed to its original metadata. No per-packet destination
  accounting is added. Process, DNS, sniff and destination information can only
  be as complete as Mihomo's existing tracker metadata.
- A final record reads counters at `Manager.Leave`. Smart trackers call this
  after closing their underlying connection. Concurrent reads/writes can still
  finish later; byte-exact final synchronization is not guaranteed. Duplicate closes and stale samples cannot reopen closed rows.
- Lifecycle states are `active`, `closed`, `unconfirmed` (disappeared without a
  persisted final), `suspended` (recording stopped cleanly), and `interrupted`
  (previous process/session did not stop cleanly). Only `closed` has a confirmed
  `endAtMs`; other terminal states retain the last known observation.
- WAL with `synchronous=NORMAL` preserves committed transactions across process
  crashes but can lose recent commits on OS failure or power loss. Unobserved,
  queued or discarded traffic cannot be recovered. This is usage history, not a
  billing-grade audit log.

## Controller API

Routes are under `/traffic-history`, using the existing controller secret,
authentication and CORS configuration. No separate listener is opened.

| GET route | Result |
| --- | --- |
| `/status` | Enabled/ready/healthy state, session, queue, loss/error counts, last commit, retention and GeoIP warnings |
| `/flows` | Connection records in ascending database ID order |
| `/flows/{id}` | One database record, including metadata, chains and geo |
| `/flows/{id}/samples` | This record's timestamped increments |
| `/summary` | Upload/download totals, new and participating connection counts |
| `/series` | Totals grouped by UTC time bucket |
| `/groups` | Totals grouped by one to three dimensions |

Common parameters:

- `from`, `to`: UTC Unix milliseconds, `[from,to)`, default last 24 hours,
  maximum 31 days per query.
- `limit`: 1–1000, default 100. `cursor`: nonnegative row ID for flow/sample
  pagination; pass the response's `nextCursor` for the next page.
- `interval`: `1m`, `1h`, or `1d` for series, default `1m`, UTC aligned.
- `group_by`: comma-separated dimension names, required for `/groups`.
- `include_internal`: boolean, default false.
- Exact-match filters and grouping dimensions: `domain`, `destinationIP`,
  `sourceIP`, `process`, `processPath`, `network`, `inbound`, `rule`,
  `rulePayload`, `policy`, `proxy`, `chain`, `country`, `asn`.

`process` uses the process path when available, otherwise the process name.
`domain` uses host, falling back to sniffHost. `inbound` uses the inbound name,
falling back to its type. `policy` is the last chain hop;
`proxy` is the first. Raw rule type and payload remain separate. `chain` filter
values use the JSON array representation, e.g. `["node","group"]`; grouped
chains are returned as arrays. A future neko-master adapter can reproduce its
policy-group naming and build the flow graph from the ordered chain.

Responses contain `data`, `from`, `to`, `lastCommitAt` and `truncated`.
Single-flow/summary data is an object; list/series/group data is an array.
Truncated flow/sample responses have `nextCursor`. For truncated trends, narrow
the range or increase `limit`/`interval`; grouped results are top usage entries.
JSON object keys are camel case (`startAtMs`, `lastAtMs`, `trackerId`, etc.);
`metadata`, `chains`, `providerChains` and `geo` are decoded JSON values.
Flow lists select records overlapping the range by start/last known state observation
(active records remain visible); sample queries and aggregates filter `atMs`.
`/flows/{id}` addresses the stored record directly, independent of range filters.

All reads observe committed data and do not flush the writer. At most two
queries execute simultaneously, with a two-second deadline. Invalid input is
400, unknown record ID is 404, saturated query concurrency is 429, and disabled
or unavailable recording is 503. `/status` is always available. No arbitrary SQL
or unbounded result mode is exposed.

```sh
curl -H 'Authorization: Bearer YOUR_SECRET' \
  'http://127.0.0.1:9090/traffic-history/status'
curl -H 'Authorization: Bearer YOUR_SECRET' \
  'http://127.0.0.1:9090/traffic-history/groups?group_by=policy,chain&limit=100'
curl -H 'Authorization: Bearer YOUR_SECRET' \
  'http://127.0.0.1:9090/traffic-history/series?interval=1h'
```

## Verification

Run tests with `go test ./component/traffic_history ./tunnel/statistic ./config
./hub/route`; use `go test -race` for concurrency checks. The tests inject failed
transactions, exercise cumulative retry/idempotency, queue/memory saturation,
metadata ownership, restart/retention, query accounting and API validation.
`BenchmarkFinalAdmission` and `BenchmarkBatchWriter` measure admission overhead
and batch throughput; these do not by themselves establish end-to-end proxy
throughput. Network acceptance targets are <=1% loss with recording disabled and
<=3% enabled at 10,000 active connections plus 1,000 short connections/s, with no
record loss under the healthy acceptance workload. Record CPU/RSS/GC, close
latency and disk writes alongside throughput when evaluating a target device.

The Linux smoke and acceptance tools are checked in under `test/`. From the
repository root, build `.cache/mihomo-current`, then run:

```sh
python3 test/traffic_history_udp.py
MIHOMO_HISTORY_STRESS=1 go test ./component/traffic_history -run TestHealthyLoad -count=1 -v
go build -o .cache/history-bench test/traffic_history_bench.go
.cache/history-bench -baseline /path/to/upstream-mihomo \
  -current .cache/mihomo-current -duration 35s -repeat 3 \
  -active 10000 -rate 1000 -streams 4
```

Use the same Go toolchain and build flags for both binaries. The load generator
uses multiple loopback addresses and destination ports to avoid exhausting
ephemeral ports. Its output includes connection failures, recorder drops,
committed totals, peak RSS, process CPU time and physical writes; a run with
connection failures or recorder drops is not a valid healthy-load acceptance run.


## Mihomomo daily history (schema v3)

Mihomomo preserves Smart target tracking and all Smart metadata, and adds
transactional permanent daily aggregation. Raw flow metadata and samples retain
30 days by default (`retention-days`); cleanup never deletes daily aggregates.
Daily aggregation keeps all supported dimensions (including complete chains,
process paths, rules and payloads, source/destination addresses, country and ASN),
with no top-N eviction. Daily rows retain frozen GeoIP; raw metadata, ports and tracker IDs do not fragment
aggregation. Full Smart metadata stays in raw flows within their retention window.

`resolution=raw` is the default on existing endpoints and retains the 31-day range
limit. `resolution=day` supports only `/summary`, `/series`, and `/groups`, accepts
at most 366 **calendar days**, and requires `interval=1d` (defaulted when omitted).
Supply `from` and `to` as exact calendar-day start boundaries in `aggregationTimezone`;
misaligned boundaries return HTTP 400 instead of silently expanding the range.
A date whose midnight is skipped starts at its first valid instant (possibly
01:00); repeated midnight uses the first occurrence. Entirely skipped dates
normalize to the next existing date and produce no fabricated bucket.
Day series return `time` (inclusive start) and `endTime` (exclusive end), both Unix
milliseconds; DST days can span 23 or 25 hours. Results include `resolution` and
`aggregationTimezone`. Existing filters, grouping, internal-traffic exclusion and
truncation apply to both resolutions.

Traffic deltas are attributed to the calendar day of observation, matching raw
sample accounting. No interpolation across midnight is invented. `connections`
is newly observed, non-preexisting connections; it is additive across days.
`participatingConnections` is **null** for daily results: a flow can appear on
multiple days, so adding daily distinct counts would not produce a correct
range-wide distinct count. Use raw data for precise participating-flow counts.

The optional `aggregation-timezone` configuration accepts an IANA timezone.
Otherwise first initialization saves the system's local timezone rules in the
SQLite database. Later OS timezone changes do not regroup history. A different
explicit timezone is rejected for an existing database; use a new database to
start a different aggregation calendar. Linux/macOS local TZif rules are saved
verbatim; native OS zones without a TZif file are snapshotted for 1800–2600.

Schema v1/v2 databases migrate transactionally and backfill all retained samples
exactly once before raw retention runs. Samples already removed before migration
cannot be recovered. Checkpoint advancement, raw insertion and daily addition
commit in one transaction; retrying a checkpoint cannot add its traffic twice.
Status exposes `aggregationTimezone`, `detailAvailableFrom` (oldest surviving
raw sample), and `aggregateAvailableFrom` (first stored day boundary). Null
coverage means no observations; these dates do not imply uninterrupted recording.
All existing JSON casing, including `sourceIp` and `destinationIp`, is preserved.

Focused regression coverage includes legacy migration and failed-backfill retry,
transaction rollback/retry, raw cleanup while retaining daily totals, restart and
saved timezone rejection, DST boundaries, query dimensions, null distinct counts,
Smart metadata and Manager Join/Leave target registration. Historical benchmark
results in the validation report predate daily aggregation and are not a measured
performance claim for this version.


Current Mihomomo validation and measured throughput are recorded in
[traffic-history-mihomomo-validation.md](traffic-history-mihomomo-validation.md).
The measured 5-second policy has zero accounting loss but **does not pass** the
3% enabled-throughput target (3.288% median loss in that run).
