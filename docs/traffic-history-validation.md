> Historical validation from the original traffic-only port. The daily aggregation extension requires fresh measurements; numbers below do not describe its performance.

# Traffic history verification — 2026-10-22

Source baseline: `3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8`.
The modified source is the working tree accompanying this report. Tests and
builds ran in `xjtuse-arch-dev` on native Linux/amd64, with Go 1.27.3 and
modernc.org/sqlite v1.61.0. No local macOS compilation was used.

## Functional results

- The complete `CGO_ENABLED=0 go test ./...` suite passed, including vet checks.
- The complete `CGO_ENABLED=0 go test -tags with_gvisor ./...` suite also passed.
- `go test -race ./component/traffic_history ./tunnel/statistic ./config
  ./hub/route` passed with `CGO_ENABLED=1` (the race detector's requirement).
  SQLite itself remains pure Go.
- Transaction failure injection verified rollback across both the counter
  checkpoint and samples. Repeated batches, stale snapshots and duplicate closes
  did not duplicate recorded bytes or connection counts.
- Queue/memory saturation and injected storage failures verified bounded pending
  records and admission without waiting for SQLite. Concurrent shutdown with
  1,000 leaves preserved all connection rows.
- Schema v1→v2 migration preserved IDs, counters and foreign keys. Retention
  drained 1,501 expired flows, retained active/recently unconfirmed checkpoints,
  and never reused deleted flow/sample IDs. Windows URI construction and a native
  driver initialization test cover spaces, `#` and local drive paths.
- API tests verified inherited authentication, invalid query rejection, SQL
  identifier allowlists, cursor boundaries, and the distinction between a
  nonexistent flow (404) and an existing flow with no matching samples.
- The real SOCKS5 UDP smoke test transferred ten 100-byte payloads in each
  direction. Periodic snapshots, explicit Controller close, history queries and
  the final SQLite contents all reported exactly 1,000 uploaded bytes, 1,000
  downloaded bytes and one UDP connection.
- The recording stress test sustained 10,000 active counters and 1,000 completed
  connections/s for five seconds, with **1-second sampling** (more frequent than
  the 30-second default). It recorded all 5,000 completed connections without
  drops, skipped samples or storage errors.

## Release targets

The release matrix and Makefile publish only the following targets. Each final
target was cross-built with `CGO_ENABLED=0`, `-tags with_gvisor`, `-trimpath`,
and stripped symbols. Both x86_64 targets use `GOAMD64=v1`.

| Release target | Go target | Verified format | Build |
| --- | --- | --- | --- |
| macOS arm64 | darwin/arm64 | Mach-O 64-bit arm64 | Passed |
| Linux x86_64 | linux/amd64 | Statically linked ELF x86-64 | Passed |
| Windows x86_64 | windows/amd64 | PE32+ x86-64 | Passed |

`make -n releases` selects only these three binary archives. Docker is limited
to `linux/amd64`; its artifact selector was checked against the new filename and
rejects unsupported targets. Compilation does not establish native Windows/macOS
runtime correctness; those runs are configured in CI. No release was published.
The legacy Nix packaging expression was outside this verification.

Reproduction tools: [UDP smoke test](../test/traffic_history_udp.py),
[recording tests](../component/traffic_history/history_test.go),
[network benchmark](../test/traffic_history_bench.go).

## Network performance

Hardware: Intel Core i5-9500, six logical CPUs. The baseline and modified binaries
used the same official Go 1.27.3 toolchain, `CGO_ENABLED=0`, and ordinary build
flags. Three rounds alternated baseline/disabled/enabled order. Each mode had
10,000 idle proxied connections, four bulk SOCKS5 TCP echo streams, and a target
of 1,000 short connections/s, measured for 35 seconds. Enabled recording used the
default 30-second sampling, 1-second flush and 30-day retention; local GeoIP
lookup was disabled to isolate recording costs.

Values below are the median of the three measurements for each mode. Throughput
counts both directions of the echo transfer. Loss compares each mode's median
with the baseline median; this is not a claim of an identical per-round loss.

| Mode | Throughput (MiB/s) | Throughput loss | CPU cores | Peak RSS (MiB) | Physical writes (MiB/s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original baseline | 2862.644 | — | 2.454 | 352.973 | 0 |
| Recording disabled | 2854.846 | 0.27% | 2.460 | 357.902 | 0 |
| Recording enabled | 2809.640 | 1.85% | 2.533 | 387.016 | 8.234 |

All nine runs had zero short-connection failures. Every enabled run had zero
record drops, skipped samples and write errors, including graceful draining.
The enabled runs persisted 45,004, 45,004 and 44,994 closed records respectively;
the final run generated ten fewer short connections due to ticker scheduling,
not dropped traffic records. Actual generation rates were about 999.7–1,000/s.

This meets the chosen <=1% disabled and <=3% enabled throughput gates **in this
Linux loopback workload**. The measurements also show the resource cost: about
34 MiB additional peak RSS and 0.08 additional CPU core relative to the original
baseline, plus substantial physical writes at a sustained 1,000 connections/s.
A 30-day retention period is not a fixed disk-space limit. These numbers do not
establish results for other hardware, physical networks, protocols or MMDB data.
GC pause times and core connection-close p99 latency were not separately profiled.

Raw final measurements are in [traffic-history-benchmark.jsonl](traffic-history-benchmark.jsonl).
See [the feature documentation](traffic-history.md#verification) for reproduction
commands. The native Windows/macOS runtime checks and Go 1.26 run are configured
in CI; they were not executed in this session.
