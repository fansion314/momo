#!/bin/bash
# Disposable GitHub macOS runner only. Never invoke on a user's installed system.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -sm)" = 'Darwin arm64'
validation_root=$(cd "$(dirname "$0")" && pwd)
tag=$(node -p 'require("./packaging/macos/release.json").coreTag')
revision=6
version=${tag#mihomomo-v}
archive="mihomomo-${version}-macos-arm64-r${revision}.tar.gz"
stage=$(mktemp -d)
cleanup() {
  sudo "/Library/PrivilegedHelperTools/world.fansionia.clash-momo.helper" uninstall || true
  if [[ "$(readlink /opt/homebrew/opt/mihomomo 2>/dev/null || true)" == "$stage" ]]; then rm /opt/homebrew/opt/mihomomo; fi
  rm -rf "$stage"
}
trap cleanup EXIT
for attempt in {1..120}; do
  if gh release view "$tag" -R fansion314/momo --json isDraft,assets | node -e '
    const fs = require("node:fs")
    const release = JSON.parse(fs.readFileSync(0, "utf8"))
    const names = new Set(release.assets.map(asset => asset.name))
    const archive = process.argv[1]
    if (release.isDraft || !names.has(archive) || !names.has(archive + ".sha256")) process.exit(1)
  ' "$archive"; then break; fi
  if (( attempt == 120 )); then echo "Required core release is unavailable: $tag" >&2; exit 1; fi
  echo "Waiting for required core release $tag (attempt $attempt/120)"
  sleep 10
done
gh release download "$tag" -R fansion314/momo -p "$archive" -p "$archive.sha256" -D "$stage"
(cd "$stage" && shasum -a 256 -c "$archive.sha256")
tar -xzf "$stage/$archive" -C "$stage"
helper="$PWD/dist/macos/Clash Momo.app/Contents/Resources/files/world.fansionia.clash-momo.helper"
mkdir -p dist/validation
# Build the immutable previously released Go service solely as an upgrade fixture.
git archive f769c662e7d86f7bc5de10574f0577ab3e719b4f packaging/macos/helper | tar -x -C "$stage"
(cd "$stage/packaging/macos/helper" && go build -trimpath -o "$stage/go-helper" .)
sudo "$stage/go-helper" install --uid "$(id -u)" --core "$stage/bin/mihomomo"
python3 "$validation_root/benchmark-helper.py" go "$stage/benchmark-go.json"
cp "$stage/benchmark-go.json" dist/validation/
python3 "$validation_root/test-service-ci.py"
sudo /usr/bin/python3 - <<'PY'
import sqlite3
from pathlib import Path
database = Path('/Library/Application Support/world.fansionia.clash-momo/data/traffic-history.db')
assert database.is_file(), 'Go managed core did not create the history database'
with sqlite3.connect(database) as connection:
    connection.execute('CREATE TABLE IF NOT EXISTS momo_upgrade_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    connection.execute("INSERT OR REPLACE INTO momo_upgrade_fixture VALUES (1, 'preserve Go helper history across Rust upgrade')")
PY
# Reproduce the legacy-service upgrade path. The old helper chowned its socket to the
# application UID, while its containing directories remained root-owned.
legacy_root='/Library/Application Support/world.fansionia.clash-momo'
legacy_socket="$legacy_root/run/helper.sock"
sudo mkdir -p "$legacy_root/run"
sudo chown root:wheel "$legacy_root" "$legacy_root/run"
sudo chmod 755 "$legacy_root" "$legacy_root/run"
sudo /usr/bin/python3 - "$legacy_socket" <<'PY'
import socket
import sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
s.close()
PY
sudo chown "$(id -u):$(id -gn)" "$legacy_socket"
sudo "$helper" install --uid "$(id -u)" --core "$stage/bin/mihomomo"
sudo test ! -e "$legacy_socket"
sudo /usr/bin/python3 - <<'PY'
import sqlite3
with sqlite3.connect('/Library/Application Support/world.fansionia.clash-momo/data/traffic-history.db') as connection:
    assert connection.execute('SELECT value FROM momo_upgrade_fixture WHERE id=1').fetchone() == ('preserve Go helper history across Rust upgrade',)
PY
python3 "$validation_root/benchmark-helper.py" rust "$stage/benchmark-rust.json"
cp "$stage/benchmark-rust.json" dist/validation/
python3 "$validation_root/test-service-ci.py"
# Reinstall tests the same authorized transaction and protected state retention.
sudo "$helper" install --uid "$(id -u)" --core "$stage/bin/mihomomo"
python3 "$validation_root/test-service-ci.py"
sudo /usr/bin/python3 - <<'PY'
import sqlite3
with sqlite3.connect('/Library/Application Support/world.fansionia.clash-momo/data/traffic-history.db') as connection:
    assert connection.execute('SELECT value FROM momo_upgrade_fixture WHERE id=1').fetchone() == ('preserve Go helper history across Rust upgrade',)
PY
# Exercise the packaged renderer and public controller against this exact core.
test ! -e /opt/homebrew/opt/mihomomo
ln -s "$stage" /opt/homebrew/opt/mihomomo
node "$validation_root/smoke.mjs"
rm /opt/homebrew/opt/mihomomo
