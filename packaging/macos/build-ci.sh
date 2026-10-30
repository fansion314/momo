#!/bin/bash
set -euo pipefail
test "$(uname -sm)" = 'Darwin arm64'
pkgver=$(sed -n 's/^pkgver=//p' packaging/arch/PKGBUILD)
pkgrel=$(sed -n 's/^pkgrel=//p' packaging/arch/PKGBUILD)
revision=$(python3 -c 'import json;print(json.load(open("packaging/macos/release.json"))["revision"])')
tag="mihomomo-v${pkgver}-${pkgrel}"
stage="$PWD/.cache/macos-package"
mkdir -p "$stage/bin" "$stage/share/mihomomo" dist/release
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 bash packaging/build-core.sh "$stage/bin/mihomomo" "$pkgver"
codesign --force --sign - --timestamp=none "$stage/bin/mihomomo"
codesign --verify --strict "$stage/bin/mihomomo"
test "$(lipo -archs "$stage/bin/mihomomo")" = arm64
test ! -u "$stage/bin/mihomomo"
"$stage/bin/mihomomo" -v | grep -F "$pkgver"
"$stage/bin/mihomomo" --momo-capabilities | python3 -c \
  'import json,sys;v=json.load(sys.stdin);assert v["protocol"]==1 and v["managedMode"] and v["version"]==sys.argv[1]' "$pkgver"
"$stage/bin/mihomomo" tizi --state-dir "$stage/tizi-capability-check" status <<<'{}' | python3 -c \
  'import json,os,sys;v=json.load(sys.stdin);assert v["ok"] and v["data"]["supported"];assert not os.environ.get("TIZI_BUILD_KEYS") or v["data"]["keyReady"]'
python3 - "$stage" "$pkgver" "$tag" "$revision" <<'PY'
import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1])
data={"version":sys.argv[2],"tag":sys.argv[3],"revision":int(sys.argv[4]),
      "source_commit":subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip(),
      "core_sha256":hashlib.sha256((root/"bin/mihomomo").read_bytes()).hexdigest(),
      "protocol":1,"architecture":"arm64","minimum_os":"15.0"}
(root/"share/mihomomo/manifest.json").write_text(json.dumps(data,indent=2)+"\n")
PY
cp LICENSE README.md "$stage/"
archive="mihomomo-${pkgver}-${pkgrel}-macos-arm64-r${revision}.tar.gz"
COPYFILE_DISABLE=1 tar -C "$stage" -czf "dist/release/$archive" bin share LICENSE README.md
(cd dist/release && shasum -a 256 "$archive" > "$archive.sha256")
