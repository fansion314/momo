#!/bin/bash
set -euo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8
root=$1
commit=$2
mkdir -p /tmp/recipe /tmp/build-output
cp "$root"/packaging/arch/{PKGBUILD,mihomomo.install} /tmp/recipe/
cd /tmp/recipe
sed -i "s/@COMMIT@/$commit/" PKGBUILD
sed -i "s/@INSTALL_SHA@/$(sha256sum mihomomo.install | cut -d' ' -f1)/" PKGBUILD
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
test ! -u /usr/bin/mihomomo
runuser -u builder -- /usr/bin/mihomomo -v | grep -F "$pkgver"
cp "$package" /tmp/build-output/
mkdir -p /tmp/bundle/aur/mihomomo
cp /tmp/recipe/{PKGBUILD,.SRCINFO,mihomomo.install} /tmp/bundle/aur/mihomomo/
mkdir -p /tmp/bundle/aur/mihomomo-bin
sed -e "s/@PKGVER@/$pkgver/g" -e "s/@PKGREL@/$pkgrel/g" \
    -e "s/@PACKAGE_SHA@/$(sha256sum "$package" | cut -d' ' -f1)/g" \
    "$root/packaging/arch/PKGBUILD-bin" > /tmp/bundle/aur/mihomomo-bin/PKGBUILD
cp /tmp/recipe/mihomomo.install /tmp/bundle/aur/mihomomo-bin/
chown -R builder:builder /tmp/bundle
runuser -u builder -- bash -c 'cd /tmp/bundle/aur/mihomomo-bin && makepkg --printsrcinfo > .SRCINFO'
# Exercise the exact recipe against the just-built bytes before release exists.
mkdir -p /tmp/bin-test
cp -a /tmp/bundle/aur/mihomomo-bin/. /tmp/bin-test/
cp "$package" /tmp/bin-test/
sed -i 's|https://github.com/fansion314/momo/releases/download/[^"]*/|file:///tmp/bin-test/|' /tmp/bin-test/PKGBUILD
chown -R builder:builder /tmp/bin-test
runuser -u builder -- bash -c 'cd /tmp/bin-test && makepkg --nodeps --noconfirm'
pacman -U --noconfirm /tmp/bin-test/mihomomo-bin-"$pkgver"-"$pkgrel"-x86_64.pkg.tar.zst
getcap /usr/bin/mihomomo | grep -F 'cap_net_bind_service,cap_net_admin,cap_net_raw=ep'
runuser -u builder -- /usr/bin/mihomomo -v | grep -F "$pkgver"
tar -C /tmp/bundle -czf /tmp/build-output/mihomomo-aur.tar.gz aur
