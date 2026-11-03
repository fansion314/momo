#!/bin/bash
# Exercise native PAC clearing only on a disabled, disposable CI network service.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -sm)" = 'Darwin arm64'
service='Clash Momo CI PAC Test'
if /usr/sbin/networksetup -listallnetworkservices | sed 's/^\*//' | grep -Fx "$service"; then
  echo 'Reserved CI service already exists; refusing to alter it' >&2
  exit 1
fi
port=$(/usr/sbin/networksetup -listallhardwareports | sed -n 's/^Hardware Port: //p' | head -1)
test -n "$port"
sudo /usr/sbin/networksetup -createnetworkservice "$service" "$port"
trap 'sudo /usr/sbin/networksetup -removenetworkservice "$service"' EXIT
sudo /usr/sbin/networksetup -setnetworkserviceenabled "$service" off
cd packaging/macos/helper
cargo test --locked --no-run --message-format=json > /tmp/clash-momo-helper-test-artifacts.json
test_binary=$(python3 - <<'PY'
import json
with open('/tmp/clash-momo-helper-test-artifacts.json') as f:
    executables = [item['executable'] for line in f if (item := json.loads(line)).get('reason') == 'compiler-artifact' and item.get('profile', {}).get('test') and item.get('executable')]
assert len(executables) == 1
print(executables[0])
PY
)
sudo "$test_binary" --nocapture
sudo "$test_binary" large_snapshot_has_bounded_memory --nocapture > /tmp/clash-momo-helper-snapshot-memory.txt
mkdir -p "$OLDPWD/dist/validation"
cp /tmp/clash-momo-helper-snapshot-memory.txt "$OLDPWD/dist/validation/"
sudo env MOMO_HELPER_TEST_NETWORK_SERVICE="$service" "$test_binary" native_scoped_proxy_dns_roundtrip --nocapture
