#!/bin/bash
set -euo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8
root=$1
commit=$2
mkdir -p /tmp/recipe /tmp/build-output
cp "$root"/packaging/arch/{PKGBUILD,clash-momo,clash-momo.desktop} /tmp/recipe/
cd /tmp/recipe
sed -i "s/@COMMIT@/$commit/" PKGBUILD
sed -i "s/@LAUNCHER_SHA@/$(sha256sum clash-momo | cut -d' ' -f1)/;s/@DESKTOP_SHA@/$(sha256sum clash-momo.desktop | cut -d' ' -f1)/" PKGBUILD
curl -fL -o /tmp/mihomomo.pkg.tar.zst https://github.com/fansion314/momo/releases/download/mihomomo-v1.19.33-1/mihomomo-1.19.33-1-x86_64.pkg.tar.zst
curl -fL -o /tmp/mihomomo.pkg.tar.zst.sig https://github.com/fansion314/momo/releases/download/mihomomo-v1.19.33-1/mihomomo-1.19.33-1-x86_64.pkg.tar.zst.sig
curl -fL -o /tmp/fansionia.asc https://raw.githubusercontent.com/fansion314/packages/main/arch/keys/fansionia.asc
mkdir -m 700 /tmp/momo-gnupg
GNUPGHOME=/tmp/momo-gnupg gpg --batch --import /tmp/fansionia.asc
GNUPGHOME=/tmp/momo-gnupg gpg --batch --with-colons --fingerprint | grep -F '338AEAB64ECF2EF69AAF3EEFDF31748072E5B972'
GNUPGHOME=/tmp/momo-gnupg gpg --batch --status-fd 1 --verify /tmp/mihomomo.pkg.tar.zst.sig /tmp/mihomomo.pkg.tar.zst | grep -E "^\[GNUPG:\] VALIDSIG .* 338AEAB64ECF2EF69AAF3EEFDF31748072E5B972$"
pacman-key --init
pacman-key --add /tmp/fansionia.asc
pacman-key --lsign-key 338AEAB64ECF2EF69AAF3EEFDF31748072E5B972
pacman -U --noconfirm /tmp/mihomomo.pkg.tar.zst
chown -R builder:builder /tmp/recipe /tmp/build-output
runuser -u builder -- bash -c 'cd /tmp/recipe && makepkg --syncdeps --noconfirm --cleanbuild && makepkg --printsrcinfo > .SRCINFO'
pkgname=$(sed -n 's/^pkgname=//p' PKGBUILD)
pkgver=$(sed -n 's/^pkgver=//p' PKGBUILD)
pkgrel=$(sed -n 's/^pkgrel=//p' PKGBUILD)
mapfile -t packages < <(find /tmp/recipe -maxdepth 1 -type f -name '*.pkg.tar.zst' -print)
package="/tmp/recipe/${pkgname}-${pkgver}-${pkgrel}-x86_64.pkg.tar.zst"
[[ ${#packages[@]} == 1 && ${packages[0]} == "$package" && -f $package ]]
tar -xOf "$package" .PKGINFO | grep -Fx "pkgname = $pkgname"
tar -xOf "$package" .PKGINFO | grep -Fx "pkgver = $pkgver-$pkgrel"
tar -xOf "$package" .PKGINFO | grep -Fx 'arch = x86_64'
pacman -U --noconfirm "$package"
getcap /usr/bin/mihomomo | grep -F 'cap_net_bind_service,cap_net_admin,cap_net_raw=ep'
runuser -u builder -- env ELECTRON_RUN_AS_NODE=1 /usr/bin/electron -e 'process.chdir("/usr/lib/clash-momo"); require("/usr/lib/clash-momo/node_modules/sysproxy-rs"); console.log(process.versions.electron)'
test "$(readlink -f /usr/bin/electron)" != /usr/lib/clash-momo/electron
test -s /usr/lib/clash-momo/resources/icon.png
test -s /usr/lib/clash-momo/resources/iconTemplate.png
test -s /usr/lib/clash-momo/resources/subStoreIcon.png
test -s /usr/lib/clash-momo/resources/files/sub-store.bundle.cjs
test -s /usr/lib/clash-momo/resources/files/country.mmdb
test -s /usr/lib/clash-momo/resources/sidecar/sysproxy.linux-x64-gnu.node
! find /usr/lib/clash-momo -type f -name mihomomo | grep .
cp "$package" /tmp/build-output/
mkdir -p /tmp/bundle/aur/clash-momo
cp /tmp/recipe/{PKGBUILD,.SRCINFO,clash-momo,clash-momo.desktop} /tmp/bundle/aur/clash-momo/
mkdir -p /tmp/bundle/aur/clash-momo-bin
sed -e "s/@PKGVER@/$pkgver/g" -e "s/@PKGREL@/$pkgrel/g" \
    -e "s/@PACKAGE_SHA@/$(sha256sum "$package" | cut -d' ' -f1)/g" \
    "$root/packaging/arch/PKGBUILD-bin" > /tmp/bundle/aur/clash-momo-bin/PKGBUILD
chown -R builder:builder /tmp/bundle
runuser -u builder -- bash -c 'cd /tmp/bundle/aur/clash-momo-bin && makepkg --printsrcinfo > .SRCINFO'
# Exercise the exact recipe against the just-built bytes before release exists.
mkdir -p /tmp/bin-test
cp -a /tmp/bundle/aur/clash-momo-bin/. /tmp/bin-test/
cp "$package" /tmp/bin-test/
sed -i 's|https://github.com/fansion314/momo/releases/download/[^"]*/|file:///tmp/bin-test/|' /tmp/bin-test/PKGBUILD
chown -R builder:builder /tmp/bin-test
runuser -u builder -- bash -c 'cd /tmp/bin-test && makepkg --nodeps --noconfirm'
pacman -Rdd --noconfirm clash-momo
pacman -U --noconfirm /tmp/bin-test/clash-momo-bin-"$pkgver"-"$pkgrel"-x86_64.pkg.tar.zst
runuser -u builder -- env ELECTRON_RUN_AS_NODE=1 /usr/bin/electron -e 'process.chdir("/usr/lib/clash-momo"); require("/usr/lib/clash-momo/node_modules/sysproxy-rs")'
tar -C /tmp/bundle -czf /tmp/build-output/clash-momo-aur.tar.gz aur
