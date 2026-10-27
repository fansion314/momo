#!/bin/bash
set -euo pipefail
root=$1
commit=$2
mkdir -p /tmp/recipe /tmp/build-output
cp "$root"/packaging/arch/{PKGBUILD,clash-momo,clash-momo.desktop} /tmp/recipe/
cd /tmp/recipe
sed -i "s/@COMMIT@/$commit/" PKGBUILD
sed -i "s/@LAUNCHER_SHA@/$(sha256sum clash-momo | cut -d' ' -f1)/;s/@DESKTOP_SHA@/$(sha256sum clash-momo.desktop | cut -d' ' -f1)/" PKGBUILD
curl -fL -o /tmp/mihomomo.pkg.tar.zst https://github.com/fansion314/momo/releases/download/mihomomo-v0.1.0-1/mihomomo-0.1.0-1-x86_64.pkg.tar.zst
curl -fL -o /tmp/mihomomo.pkg.tar.zst.sig https://github.com/fansion314/momo/releases/download/mihomomo-v0.1.0-1/mihomomo-0.1.0-1-x86_64.pkg.tar.zst.sig
curl -fL -o /tmp/fansionia.asc https://raw.githubusercontent.com/fansion314/packages/main/arch/keys/fansionia.asc
mkdir -m 700 /tmp/momo-gnupg
GNUPGHOME=/tmp/momo-gnupg gpg --batch --import /tmp/fansionia.asc
GNUPGHOME=/tmp/momo-gnupg gpg --batch --with-colons --fingerprint | grep -F '338AEAB64ECF2EF69AAF3EEFDF31748072E5B972'
GNUPGHOME=/tmp/momo-gnupg gpg --batch --status-fd 1 --verify /tmp/mihomomo.pkg.tar.zst.sig /tmp/mihomomo.pkg.tar.zst | grep -E "^\[GNUPG:\] VALIDSIG .* 338AEAB64ECF2EF69AAF3EEFDF31748072E5B972$"
pacman -U --noconfirm /tmp/mihomomo.pkg.tar.zst
chown -R builder:builder /tmp/recipe /tmp/build-output
runuser -u builder -- bash -c 'cd /tmp/recipe && makepkg --syncdeps --noconfirm --cleanbuild && makepkg --printsrcinfo > .SRCINFO'
package=$(find /tmp/recipe -maxdepth 1 -name '*.pkg.tar.zst' -print -quit)
test -n "$package"
tar -xOf "$package" .PKGINFO | grep -Fx 'pkgname = clash-momo'
tar -xOf "$package" .PKGINFO | grep -Fx 'pkgver = 0.1.0-1'
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
runuser -u builder -- bash "$root/packaging/arch/gui-smoke.sh"
! find /usr/lib/clash-momo -type f -name mihomomo | grep .
cp "$package" /tmp/build-output/
mkdir -p /tmp/bundle/aur/clash-momo
cp /tmp/recipe/{PKGBUILD,.SRCINFO,clash-momo,clash-momo.desktop} /tmp/bundle/aur/clash-momo/
tar -C /tmp/bundle -czf /tmp/build-output/clash-momo-aur.tar.gz aur
