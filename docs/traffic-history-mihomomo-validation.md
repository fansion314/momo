# Mihomomo traffic history validation — 2026-10-27

Functional accounting and recovery checks passed. The enabled-throughput target
is **not accepted**: the measured median loss with the client's 5-second sampling
policy was 3.286%, above the unchanged 3% target. Disabled recording passed
the 1% target in this run. No threshold or generator rate was relaxed.

## Environment and source identity

Native Linux amd64 in `xjtuse-arch-dev`, Intel Core i5-9500 (6 cores), Go 1.27.3.
Both comparison binaries used `CGO_ENABLED=0`, `GOAMD64=v1`, `-p 4`,
`-tags with_gvisor`, `-trimpath`, and identical linker flags:

```text
-X github.com/metacubex/mihomo/constant.Version=0.1.0
-X github.com/metacubex/mihomo/constant.BuildTime=2026-10-27
-s -w -buildid=
```

Clean Smart baseline source: `ea99c1511bf6e9293530f519ddf346b235dce5df`.
Its original dependency pins were retained; Mihomomo's module graph includes the
SQLite-required upgrades, so this measures the complete integration rather than
isolating SQLite alone. The final module minimum remains Go 1.26.0.

SHA-256 identities:

- Baseline benchmark binary: `a4f201eacf017adffb6db4144cb5e976c7b15832460c880e5103a55265f7123a`.
- Optimized benchmark binary: `6b36b0da8b9dae4ccc124ca6d851580891a8dd8b23da482e5d0b74b9f06495de`.
- Final corrected/tested binary: `56c0c8459ff89e30678d1bbb8f1f6a9c7db19134ac2ab1bded1799897a2f0c7a`.
- Final source manifest: `82510e32789f52dc3b4e916d2bcf85c524722fb04f46bbc81d37ce4cf7eb5259` (1031 files).

The source manifest includes every `.go` file (including tests) plus `go.mod` and
`go.sum`, excludes `.git`, `.cache`, `node_modules`, `target`, `build`, and `dist`,
and sorts repository-relative paths. Each line is `SHA256  relative-path\n`;
the manifest identity is SHA-256 of those UTF-8 lines. The final source includes
the midnight-DST correction made after the end-to-end performance run; it was
rebuilt and revalidated. That correction does not have a separate end-to-end
throughput measurement. The initial exploratory run did not capture an exact
source/binary fingerprint before its binary was replaced and is not release
acceptance evidence.

## Validation

- Full `go test -p 4 -tags with_gvisor ./...`: passed on final source.
- `go test -race -p 4 ./component/traffic_history ./tunnel/statistic`: passed
  (10.570 s and 3.407 s on the final run).
- `MIHOMO_HISTORY_STRESS=1 go test -count=1 -run TestHealthyLoad -v
  ./component/traffic_history`: passed. 10,000 active flows plus 5,000 short flows
  produced at 1,000/s, deliberately demanding 1-second sampling; zero dropped
  records, skipped samples, or write errors; queue and pending bytes empty after
  shutdown.
- Final release binary UDP smoke: ten 100-byte payloads through a real SOCKS UDP
  relay. Raw samples, summary, day summary and post-shutdown SQLite totals all
  matched 1,000 upload / 1,000 download / one new connection. Daily participating
  connections was null; the flow reached closed; all error/loss counters were zero.
- Short-flow writer microbenchmark: 512 new closed flows per batch, 8,478 records/s,
  60.388 ms/batch, 5,396,825 B/batch, 114,544 allocations/batch. This is writer
  capacity evidence, not a network throughput measurement.

Regression tests cover transaction rollback/retry, exactly-once legacy backfill
across 512-row chunks, raw retention preserving daily totals, saved timezone
restart/rejection, Smart Join/Leave targets and all owned/budgeted metadata
strings, and JSON field casing. Day tests cover New York's 23/25-hour days,
Santiago/São Paulo skipped midnight, Havana repeated midnight, and 366 civil days.

## End-to-end workload and results

The benchmark ran three alternating rounds, 35 measured seconds per mode:
10,000 idle active SOCKS TCP connections, 1,000 short connections/s (64-byte echo
in each direction), eight unrestricted 64-KiB echo streams. It used loopback
DIRECT routing, 32 loopback source IPs/target ports, no process lookup, no GeoIP,
recording retention 30 days, default batch512/queue8192/32MiB pending budget and
1-second flush, UTC aggregation, and 5-second sampling in the optimized run.
The config set `find-process-mode: off`, `ipv6: false`, and `log-level: error`.
No CPU pinning or frequency controls were used. Query latency was not measured.

Median values from [the complete optimized data](traffic-history-daily-benchmark-5s.jsonl):

| Mode | MiB/s | CPU cores | Peak RSS MiB | Disk writes MiB / measured35s |
| --- | ---: | ---: | ---: | ---: |
| baseline | 3505.874 | 2.744 | 371.95 | 0.00 |
| disabled | 3519.145 | 2.747 | 370.34 | 0.00 |
| enabled | 3390.678 | 2.845 | 411.96 | 330.70 |

Disabled throughput was +0.379% relative to baseline; enabled was
-3.286%. Baseline samples ranged 3,473.632–3,750.970 MiB/s, so this
small three-round test is not evidence of a universal hardware-independent
percentage. It nevertheless does **not pass** the stated enabled gate.

Every enabled run persisted all 45,008 expected flows, all closed, and 45,008 new
connections. Raw checkpoint totals, raw samples and daily totals matched exactly;
payload totals were within the explicitly bounded in-flight-stream allowance.
All enabled runs had zero final dropped/skipped/write-error counters, zero short
connection failures and approximately 1,000 successful shorts/s.

[Initial exploratory data](traffic-history-daily-benchmark-initial.jsonl) used
30-second sampling before transaction-local coalescing: medians baseline
3,498.577, disabled3,511.477, enabled3,349.594 MiB/s (enabled loss4.260%). The
optimized run used a more demanding 5-second policy, so these datasets do not
isolate the effect of coalescing alone. Coalescing preserves each raw sample and
checkpoint while combining only identical dimension/day increments inside the
same transaction; failed transactions discard the accumulator.

These results cover a native Linux loopback proxy and database recovery. They do
not establish TUN/system-proxy recovery, physical device behavior, arbitrary WAN
performance, query latency, or Windows/macOS acceptance.


## Ordinary-user native CI confirmation

On 2026-10-27, the complete suite also passed as the unprivileged `desktop`
user (UID/GID 1003), Go 1.27.3, using `go test -p 2 -tags with_gvisor ./...`.
The successful invocation ran 10:56:47–10:58:14 UTC (87 seconds), exit 0:
63 packages passed and 127 packages had no test files; zero failed packages.
The independent copy's 1,031 Go/module files matched the final source manifest
`82510e32789f52dc3b4e916d2bcf85c524722fb04f46bbc81d37ce4cf7eb5259` before
and after testing.

The ordinary user owned a separate source copy, module cache, build cache and
temporary directory under the project's `.cache`. All source and fixtures were
preserved except `.git` and the original `.cache`. Existing module bytes were
copied; the shared root module cache retained ownership 0:0. The successful run
reused results produced in this independent ordinary-user cache, not root's
build/test-result cache.

The first run encountered a network timeout fetching the V2Ray test peer's exact
x/net revision. The documented temporary LAN proxy fetched that dependency and
built the external peer as the same ordinary user. A full retry with that proxy
exposed a synthetic `example.com` HTTP fixture conflict, so the final complete
run used the original environment without an HTTP proxy. V2Ray interoperability
was exercised; no `SKIP_INTEROP_TEST`, targeted test selection or Go source change
was used. Initial/retry logs were retained separately from the successful log.

The successful complete log's SHA-256 is
`d635328af08fb8b423ff2b648b9e3433b783e85a7eaf8ed2f2f320b0e0e27038`.
This additional permissions/CI check does not change the measured 3.288%
enabled-throughput target miss documented above.
