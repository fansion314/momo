#!/usr/bin/env python3
"""Build and exercise the native x64 Windows core before creating release bytes."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
os.chdir(ROOT)
if sys.platform != 'win32' or platform.machine().lower() not in ('amd64', 'x86_64'):
    raise SystemExit('Windows packaging requires a native Windows x64 runner')
recipe = (ROOT / 'packaging/arch/PKGBUILD').read_text()
version = re.search(r'^pkgver=(.+)$', recipe, re.M)[1]
revision = int(re.search(r'^pkgrel=(\d+)$', recipe, re.M)[1])
tag = f'mihomomo-v{version}-{revision}'
stage = ROOT / '.cache/windows-package'
if stage.exists():
    shutil.rmtree(stage)
stage.mkdir(parents=True)
binary = stage / 'mihomomo.exe'
env = {**os.environ, 'CGO_ENABLED': '0', 'GOOS': 'windows', 'GOARCH': 'amd64', 'GOAMD64': 'v1'}
subprocess.run(['go', 'build', '-trimpath', '-tags', 'with_gvisor', '-ldflags',
                f'-s -w -X github.com/metacubex/mihomo/constant.Version={version}',
                '-o', str(binary), '.'], env=env, check=True)
output = subprocess.check_output([str(binary), '-v'], text=True)
assert version in output, output
capabilities = json.loads(subprocess.check_output([str(binary), '--momo-capabilities'], text=True))
assert capabilities == {'protocol': 1, 'version': version, 'managedMode': False}, capabilities
subprocess.run([sys.executable, 'packaging/windows/smoke.py', str(binary), '--tun'], check=True)
for name in ('LICENSE', 'README.md'):
    shutil.copy2(ROOT / name, stage / name)
shutil.copy2(ROOT / 'packaging/windows/WINTUN-LICENSE.txt', stage / 'WINTUN-LICENSE.txt')
(stage / 'manifest.json').write_text(json.dumps({
    'version': version, 'tag': tag, 'revision': revision,
    'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'core_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
    'protocol': 1, 'architecture': 'x64', 'minimum_os': 'Windows 10',
}, indent=2) + '\n', encoding='utf-8')
(stage / 'NOTICE.txt').write_text(
    'Mihomomo is distributed under GPL-3.0; see LICENSE.\n'
    'The Windows Wintun driver is embedded by github.com/metacubex/sing-tun; '
    'no separate driver download is required.\n'
    'Wintun: Copyright (C) 2017-2021 WireGuard LLC; see WINTUN-LICENSE.txt. '
    'https://www.wintun.net/ https://github.com/WireGuard/wintun\n', encoding='utf-8')
dist = ROOT / 'dist/release'
dist.mkdir(parents=True, exist_ok=True)
archive = dist / f'mihomomo-{version}-{revision}-windows-x64.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
    for source in sorted(stage.iterdir()):
        output.write(source, source.name)
archive.with_name(archive.name + '.sha256').write_text(
    hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n', encoding='ascii')
print(archive)
