#!/usr/bin/env python3
"""Sign the staged application from the inside out; never modifies the source tree."""
from pathlib import Path
import subprocess
import sys

app, entitlements = map(Path, sys.argv[1:])
magic = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf',
         b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}
targets = []
for path in app.rglob('*'):
    if path.is_symlink():
        continue
    if path.is_dir() and path.suffix in {'.app', '.framework'}:
        targets.append(path)
    elif path.is_file():
        with path.open('rb') as stream:
            if stream.read(4) in magic:
                architectures = subprocess.check_output(['/usr/bin/lipo', '-archs', str(path)], text=True)
                if 'arm64' not in architectures.split():
                    raise SystemExit(f'Non-ARM64 Mach-O in application: {path}')
                targets.append(path)
for path in sorted(targets, key=lambda item: len(item.parts), reverse=True) + [app]:
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none',
                    '--options', 'runtime', '--entitlements', str(entitlements), str(path)], check=True)
subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
