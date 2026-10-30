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
go_binary=$(command -v go)
cd packaging/macos/helper
sudo env MOMO_HELPER_TEST_NETWORK_SERVICE="$service" "$go_binary" test -count=1 -v -run '^TestNativePACURLClear$' .
