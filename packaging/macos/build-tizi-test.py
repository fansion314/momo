#!/usr/bin/env python3
"""Build an isolated, ad-hoc signed ARM64 tizi test app from temporary snapshots."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--core-source', type=Path, required=True)
parser.add_argument('--key-file', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[2]
key = args.key_file.read_text().strip()
if not key or ':' not in key or args.key_file.stat().st_mode & 0o077:
    raise SystemExit('A private (0600) native build key file is required')
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, MOMO_TIZI_ENABLED='true', MOMO_TIZI_TEST_BUILD='true')
env.pop('NODE_TLS_REJECT_UNAUTHORIZED', None)
env.pop('ELECTRON_SKIP_BINARY_DOWNLOAD', None)

def run(command, cwd):
    print('Running:', command[0], flush=True)
    result = subprocess.run(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    # No private build key enters the command line, but sanitize diagnostics defensively.
    safe = result.stdout.replace(key, '[private build key omitted]')
    lines = safe.splitlines()
    print('\n'.join(lines[-18:]), flush=True)
    with (output / 'build.log').open('a') as log:
        log.write(safe)
    if result.returncode:
        raise SystemExit(result.returncode)

with tempfile.TemporaryDirectory(prefix='momo-tizi-macos-') as staging:
    staging = Path(staging)
    app_source, core_source = staging / 'client', staging / 'core'
    exclusions = shutil.ignore_patterns('.git', '.codex', '.agents', '.env', '*.pem',
                                        '*.key', 'node_modules', 'target', 'dist',
                                        'out', 'extra', '.cache', '.vite', '__pycache__')
    shutil.copytree(source, app_source, ignore=exclusions, symlinks=True)
    shutil.copytree(args.core_source, core_source, ignore=exclusions, symlinks=True)
    (app_source / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
    private_source = core_source / 'component/tizi/private_build_key.go'
    fd = os.open(private_source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('//go:build tizi\n\npackage tizi\n\nfunc init() { BuildKeys = ' +
                     json.dumps(key) + ' }\n')
    native_core = staging / 'mihomomo-tizi'
    run(['go', 'build', '-buildvcs=false', '-trimpath', '-tags', 'tizi',
         '-ldflags=-s -w', '-o', str(native_core), '.'], core_source)
    private_source.unlink()
    env['MOMO_TIZI_TEST_CORE'] = str(native_core)
    run(['node', 'node_modules/electron/install.js'], app_source)
    run(['node', 'scripts/prepare.mjs'], app_source)
    run(['vp', 'run', 'build:linux'], app_source)
    run(['node', 'packaging/macos/package.mjs'], app_source)
    app = app_source / 'dist/macos-tizi-test/Clash Momo Tizi Test.app'
    destination = output / app.name
    if destination.exists():
        raise SystemExit('Output application already exists; choose a fresh output directory')
    # ditto preserves the signed bundle, symlinks and resource fork semantics.
    run(['/usr/bin/ditto', str(app), str(destination)], app_source)
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(destination)], app_source)
    archive = output / 'Clash-Momo-Tizi-Test-macOS-arm64.zip'
    run(['/usr/bin/ditto', '-c', '-k', '--keepParent', str(destination), str(archive)], app_source)
    for artifact in [archive, destination / 'Contents/Resources/files/mihomomo-tizi']:
        digest = hashlib.file_digest(artifact.open('rb'), 'sha256').hexdigest()
        (output / (artifact.name + '.sha256')).write_text(digest + '  ' + artifact.name + '\n')
    print('Built isolated test client:', destination)
