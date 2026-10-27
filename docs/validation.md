# Arch validation — 2026-10-27

The source was checked in the native x86_64 xjtuse Arch environment before the final publication. The frontend ran as the ordinary `desktop` user with Node 26.10.0, pnpm 11.8.0 and Vite+ 1.4.0. Format, ESLint, all three TypeScript checks, 609 unit tests, renderer/main builds and production dependency deployment passed. System Electron 44.5.1 loaded the packaged sysproxy native module.

The production-layout application was exercised on the isolated KDE X11 verification session with a fresh test profile, local loopback HTTP traffic and TUN/system proxy disabled. Twenty successful 128 KiB transfers were persisted without dropped records, skipped samples or write errors. A previously rejected fixture request remained in the same test database; the recorded total was 21 connections before the lightweight test.

Entering lightweight mode destroyed the only renderer while preserving both main PID and kernel PID. Six additional successful transfers were recorded with no window, increasing the stored connection count from 21 to 27. The registered native StatusNotifierItem restored the window. The 1.25 zoom factor persisted and reapplied. No duplicate kernel was created.

The summed resident set of this application's process tree decreased from 1,081,756 KiB to 843,120 KiB when the renderer exited (about 233 MiB reclaimed). This sum includes shared pages and is not a PSS or guaranteed memory budget.

Cold-start verification found and corrected the staged resource layout and the shared history path's configuration-validation safe root. The release smoke test now requires the instance's own kernel version and history readiness instead of accepting a merely surviving Electron process.

The shared GPU container does not expose `/dev/net/tun` or NET_ADMIN in its capability bounding set. Physical TUN routing and desktop system-proxy restoration were not accepted there. Release installation checks run in disposable Arch containers with the file-capability bounding set required by the kernel package. Kernel accounting, stress, race and throughput evidence is maintained on the `mihomomo` branch in `docs/traffic-history-mihomomo-validation.md`.

The release bootstrap also passed real pacman detached-signature and installed-dependency validation against the public signed core package in an isolated keyring and package database. Package scripts were disabled for that shared-container check; the system trust store and package database were unchanged. Both final recipes produced one main package each under UTF-8 locale.

A disposable rootless Arch installation container then resolved official runtime dependencies, installed the public signed core and the locally built client, verified the core file capabilities, loaded sysproxy with system Electron 44.9.3, and passed the exact release GUI readiness test. Its CI security options permit Chromium sandbox namespace creation; the application launcher receives no global `--no-sandbox` flag. The container was removed after the test, with no changes to the shared GPU container.
