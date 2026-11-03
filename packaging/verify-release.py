#!/usr/bin/env python3
"""Refuse to expose a release until GitHub stores every expected immutable byte."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

tag, directory = sys.argv[1:]
expected = {file.name: (file.stat().st_size, 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest())
            for file in Path(directory).iterdir() if file.is_file()}
if not expected:
    raise SystemExit('No release files to verify')
for attempt in range(10):
    release = json.loads(subprocess.check_output(
        ['gh', 'release', 'view', tag, '--json', 'isDraft,tagName,assets'], text=True))
    if release['tagName'] != tag or not release['isDraft']:
        raise SystemExit('Only the unpublished draft for the exact tag can be verified')
    actual = {asset['name']: (asset['size'], asset.get('digest')) for asset in release['assets']}
    if actual == expected:
        print(f'Verified {len(expected)} draft assets by size and SHA-256')
        break
    if attempt == 9:
        raise SystemExit('Draft assets are incomplete or differ; draft retained without overwriting. '
                         'Inspect and explicitly remove the failed draft before retrying.')
    time.sleep(3)
