#!/usr/bin/env bash
# Run as an ordinary user in a disposable environment with Xvfb and system Electron.
set -euo pipefail
smoke_dir=$(mktemp -d /tmp/clash-momo-smoke.XXXXXXXX)
app_group=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n $app_group ]]; then
    kill -TERM -- "-$app_group" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$app_group" 2>/dev/null || true
    wait "$app_group" 2>/dev/null || true
  fi
  if (( status != 0 )); then
    cat "$smoke_dir/app.log" 2>/dev/null || true
    find "$smoke_dir/config/clash-momo/logs" -type f -exec tail -n 100 {} \; 2>/dev/null || true
  fi
  rm -rf "$smoke_dir"
  exit "$status"
}
trap cleanup EXIT
export HOME="$smoke_dir/home"
export XDG_CONFIG_HOME="$smoke_dir/config"
export XDG_CACHE_HOME="$smoke_dir/cache"
mkdir -p "$HOME" "$XDG_CONFIG_HOME/clash-momo" "$XDG_CACHE_HOME"
cat > "$XDG_CONFIG_HOME/clash-momo/config.yaml" <<'CONFIG'
modeSelected: true
operationMode: standard
sysProxy:
  enable: false
  mode: manual
autoSetDNS: false
enableTrafficLogger: true
enableMixedPort: false
enableSocksPort: false
enableHttpPort: false
enableRedirPort: false
enableTproxyPort: false
autoUpdateProfileOnStart: false
autoCheckUpdate: false
CONFIG
cat > "$XDG_CONFIG_HOME/clash-momo/mihomo.yaml" <<'CONFIG'
tun:
  enable: false
dns:
  enable: false
mixed-port: 0
port: 0
socks-port: 0
redir-port: 0
tproxy-port: 0
CONFIG
setsid xvfb-run -a /usr/bin/clash-momo >"$smoke_dir/app.log" 2>&1 &
app_group=$!
uid=$(id -u)
for ((attempt=0; attempt<90; attempt++)); do
  if ! kill -0 "$app_group" 2>/dev/null; then
    echo 'Clash Momo exited before its core became ready' >&2
    exit 1
  fi
  for socket in /tmp/clash-momo-"$uid"-*.sock; do
    [[ -S $socket ]] || continue
    pid=${socket##*-}
    pid=${pid%.sock}
    [[ $pid =~ ^[0-9]+$ && -r /proc/$pid/environ ]] || continue
    # Do not accidentally accept another instance owned by this user.
    if ! tr '\0' '\n' < "/proc/$pid/environ" | grep -Fxq "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"; then
      continue
    fi
    if curl -fsS --max-time 2 --unix-socket "$socket" http://localhost/version |
      node -e 'let d="";process.stdin.on("data",x=>d+=x);process.stdin.on("end",()=>{if(JSON.parse(d).version!=="0.1.0") process.exit(1)})' &&
      curl -fsS --max-time 2 --unix-socket "$socket" http://localhost/traffic-history/status |
      node -e 'let d="";process.stdin.on("data",x=>d+=x);process.stdin.on("end",()=>{let s=JSON.parse(d);if(s.enabled!==true||s.ready!==true) process.exit(1)})'; then
      echo 'System Electron started Mihomomo and traffic history is ready.'
      exit 0
    fi
  done
  sleep 1
done
echo 'Clash Momo core or traffic history did not become ready within 90 seconds' >&2
exit 1
