#!/bin/bash
set -euo pipefail
test "$(uname -sm)" = 'Darwin arm64'
root=$(pwd)
pkgver=$(node -p 'require("./package.json").version')
pkgrel=$(sed -n 's/^pkgrel=//p' packaging/arch/PKGBUILD)
revision=$(node -p 'require("./packaging/macos/release.json").revision')
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
node scripts/prepare.mjs
pnpm --package=vite-plus@1.4.0 dlx vp run build:macos
app="$root/dist/macos/Clash Momo.app"
electron="$app/Contents/MacOS/Clash Momo"
test ! -e "$app/Contents/Resources/sidecar/mihomomo"
test -x "$app/Contents/Resources/files/world.fansionia.clash-momo.helper"
codesign --verify --deep --strict "$app"
ELECTRON_RUN_AS_NODE=1 "$electron" -e 'const path=require("node:path");const app=process.argv[1];process.chdir(app);require(path.join(app,"node_modules/sysproxy-rs"));if(process.arch!=="arm64")process.exit(1)' "$app/Contents/Resources/app"
mkdir -p dist/release
archive="clash-momo-${pkgver}-${pkgrel}-macos-arm64-r${revision}.tar.gz"
COPYFILE_DISABLE=1 tar -C dist/macos -czf "dist/release/$archive" 'Clash Momo.app'
(cd dist/release && shasum -a 256 "$archive" > "$archive.sha256")
