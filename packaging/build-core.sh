#!/bin/bash
# Build the normal core with optional group subscriptions enabled. Release callers
# set TIZI_REQUIRE_BUILD_KEYS=true; local source builds reuse a persistent key.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
output=${1:?output binary required}
version=${2:?version required}
mkdir -p .cache
lock=.cache/tizi-native-build.lock
if ! mkdir "$lock" 2>/dev/null; then
  echo 'Another tizi native build owns this checkout' >&2
  exit 1
fi
generated=component/tizi/zz_build_keys_generated.go
cleanup() { rm -f "$generated"; rmdir "$lock"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -e "$generated" ]]; then
  echo 'Refusing to overwrite an existing generated tizi key file' >&2
  trap - EXIT
  rmdir "$lock"
  exit 1
fi
if [[ ${TIZI_REQUIRE_BUILD_KEYS:-false} == true && -z ${TIZI_BUILD_KEYS:-} ]]; then
  echo 'Release builds require private TIZI_BUILD_KEYS' >&2
  exit 1
fi
if [[ -z ${TIZI_BUILD_KEYS:-} ]]; then
  key_file=${TIZI_BUILD_KEYS_FILE:-${XDG_DATA_HOME:-$HOME/.local/share}/mihomomo/build-keys}
  TIZI_BUILD_KEYS=$(python3 - "$key_file" <<'PYKEY'
import base64, os, pathlib, secrets, stat, sys
path=pathlib.Path(sys.argv[1])
path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
try:
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
except FileExistsError:
    pass
else:
    with os.fdopen(fd,'w') as f:
        f.write('local:'+base64.b64encode(secrets.token_bytes(32)).decode()+'\n')
info=path.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
    raise SystemExit('Local tizi build key must be an owner-only regular file')
print(path.read_text().strip())
PYKEY
  )
  export TIZI_BUILD_KEYS
fi
if [[ -n ${TIZI_BUILD_KEYS:-} ]]; then
  python3 - "$generated" <<'PY'
import base64, os, re, sys
raw=os.environ['TIZI_BUILD_KEYS'].strip()
seen=set()
try:
    for entry in raw.split(','):
        key_id, encoded=entry.split(':',1)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',key_id) or key_id in seen:
            raise ValueError()
        seen.add(key_id)
        if len(base64.b64decode(encoded,validate=True)) != 32:
            raise ValueError()
except (ValueError,TypeError):
    raise SystemExit('Invalid private TIZI_BUILD_KEYS format')
source='//go:build tizi\n\npackage tizi\n\nfunc init() { BuildKeys = string([]byte{'+','.join(str(b) for b in raw.encode())+'}) }\n'
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
    f.write(source)
PY
fi
CGO_ENABLED=${CGO_ENABLED:-0} go build -trimpath -tags with_gvisor,tizi \
  -ldflags "-s -w -X github.com/metacubex/mihomo/constant.Version=$version" \
  -o "$output" .
