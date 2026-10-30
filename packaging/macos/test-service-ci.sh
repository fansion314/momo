#!/bin/bash
# Disposable GitHub macOS runner only. Never invoke on a user's installed system.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -sm)" = 'Darwin arm64'
tag=$(node -p 'require("./packaging/macos/release.json").coreTag')
revision=2
version=${tag#mihomomo-v}
archive="mihomomo-${version}-macos-arm64-r${revision}.tar.gz"
stage=$(mktemp -d)
trap 'sudo "/Library/PrivilegedHelperTools/world.fansionia.clash-momo.helper" uninstall || true; rm -rf "$stage"' EXIT
for attempt in {1..30}; do
  if gh release view "$tag" -R fansion314/momo >/dev/null 2>&1; then break; fi
  if (( attempt == 30 )); then echo "Required core release is unavailable: $tag" >&2; exit 1; fi
  echo "Waiting for required core release $tag (attempt $attempt/30)"
  sleep 10
done
gh release download "$tag" -R fansion314/momo -p "$archive" -p "$archive.sha256" -D "$stage"
(cd "$stage" && shasum -a 256 -c "$archive.sha256")
tar -xzf "$stage/$archive" -C "$stage"
helper="$PWD/dist/macos/Clash Momo.app/Contents/Resources/files/world.fansionia.clash-momo.helper"
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
python3 packaging/macos/test-service-ci.py
# Reinstall tests the same authorized transaction and protected state retention.
sudo "$helper" install --uid "$(id -u)" --core "$stage/bin/mihomomo"
python3 packaging/macos/test-service-ci.py
