#!/bin/bash
set -euo pipefail
root=$1
commit=$2
mkdir -p /tmp/recipe /tmp/build-output
cp "$root"/packaging/arch/{PKGBUILD,mihomomo.install} /tmp/recipe/
cd /tmp/recipe
sed -i "s/@COMMIT@/$commit/" PKGBUILD
sed -i "s/@INSTALL_SHA@/$(sha256sum mihomomo.install | cut -d' ' -f1)/" PKGBUILD
chown -R builder:builder /tmp/recipe /tmp/build-output
runuser -u builder -- bash -c 'cd /tmp/recipe && makepkg --syncdeps --noconfirm --cleanbuild && makepkg --printsrcinfo > .SRCINFO'
package=$(find /tmp/recipe -maxdepth 1 -name '*.pkg.tar.zst' -print -quit)
test -n "$package"
tar -xOf "$package" .PKGINFO | grep -Fx 'pkgname = mihomomo'
tar -xOf "$package" .PKGINFO | grep -Fx 'pkgver = 0.1.0-1'
tar -xOf "$package" .PKGINFO | grep -Fx 'arch = x86_64'
pacman -U --noconfirm "$package"
getcap /usr/bin/mihomomo | grep -F 'cap_net_bind_service,cap_net_admin,cap_net_raw=ep'
test ! -u /usr/bin/mihomomo
runuser -u builder -- /usr/bin/mihomomo -v | grep -F 0.1.0
cp "$package" /tmp/build-output/
mkdir -p /tmp/bundle/aur/mihomomo
cp /tmp/recipe/{PKGBUILD,.SRCINFO,mihomomo.install} /tmp/bundle/aur/mihomomo/
tar -C /tmp/bundle -czf /tmp/build-output/mihomomo-aur.tar.gz aur
