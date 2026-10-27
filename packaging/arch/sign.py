#!/usr/bin/env python3
"""Sign exact release packages, reusing existing valid detached signatures."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def run(*args, **kwargs):
    return subprocess.check_output(args, **kwargs)


def api(path):
    return json.loads(run('gh', 'api', '-H', 'Cache-Control: no-cache', path))


def checksum(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def release(repository, tag):
    pages = json.loads(run('gh', 'api', '--paginate', '--slurp', '-H', 'Cache-Control: no-cache',
                          f'repos/{repository}/releases?per_page=100'))
    matches = [r for page in pages for r in page if r['tag_name'] == tag]
    if len(matches) > 1:
        raise ValueError('Ambiguous release tag')
    return matches[0] if matches else None


class Signer:
    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix='fansionia-gpg-')
        self.environment = dict(os.environ, GNUPGHOME=self.directory.name)
        os.chmod(self.directory.name, 0o700)
        self.key = os.environ['ARCH_SIGNING_KEY_ID']
        if not re.fullmatch(r'[A-Fa-f0-9]{40,64}', self.key):
            raise ValueError('Signing key must be a full fingerprint')
        self.gpg('--import', input=os.environ['ARCH_SIGNING_PRIVATE_KEY'].encode())
        listing = self.gpg('--with-colons', '--list-secret-keys', self.key).decode()
        expiries = [int(line.split(':')[6]) for line in listing.splitlines()
                    if line.startswith(('sec:', 'ssb:')) and line.split(':')[6]]
        if any(expiry <= time.time() + 45*86400 for expiry in expiries):
            raise ValueError('Signing key expires within 45 days; renew the signing subkey first')
        self.passphrase = Path(self.directory.name)/'passphrase'
        self.passphrase.write_text(os.environ['ARCH_SIGNING_PASSPHRASE'])
        self.passphrase.chmod(0o600)
        return self

    def gpg(self, *args, **kwargs):
        result = subprocess.run(['gpg', '--batch', '--no-tty', *args], env=self.environment,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
        if result.returncode:
            raise RuntimeError('GnuPG operation failed: '+result.stderr.decode(errors='replace'))
        return result.stdout

    def sign(self, path):
        path = Path(path)
        signature = Path(str(path)+'.sig')
        if signature.exists():
            self.verify(path)
        else:
            self.gpg('--pinentry-mode', 'loopback', '--passphrase-file', str(self.passphrase),
                     '--local-user', self.key+'!', '--output', str(signature), '--detach-sign', str(path))
            self.verify(path)
        return signature

    def verify(self, path):
        status = self.gpg('--status-fd', '1', '--verify', str(path)+'.sig', str(path)).decode()
        if not any(line.startswith('[GNUPG:] VALIDSIG '+self.key.upper()+' ') for line in status.splitlines()):
            raise ValueError('Signature does not belong to this repository signing subkey')

    def __exit__(self, *args):
        subprocess.run(['gpgconf', '--homedir', self.directory.name, '--kill', 'gpg-agent'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.directory.cleanup()


def sign_directory(directory, repository, tag):
    directory = Path(directory)
    current = release(repository, tag) if tag else None
    assets = {a['name']: a for a in current['assets']} if current else {}
    packages = sorted(directory.glob('*.pkg.tar.zst'))
    if not packages:
        raise ValueError('No pacman packages to sign')
    with Signer() as signer:
        for package in packages:
            existing = assets.get(package.name)
            if existing and existing.get('digest') != 'sha256:'+checksum(package):
                raise ValueError('Refusing to sign bytes different from the published package')
            signature = Path(str(package)+'.sig')
            if signature.name in assets and not signature.exists():
                subprocess.run(['gh', 'release', 'download', tag, '-R', repository,
                                '-p', signature.name, '-D', str(directory)], check=True)
            signer.sign(package)
            if signature.name in assets and assets[signature.name].get('digest') != 'sha256:'+checksum(signature):
                raise ValueError('Existing signature bytes differ')


def backfill(repository, tag):
    current = release(repository, tag)
    if not current or current['draft']:
        raise ValueError('Backfill requires a public release')
    if current.get('immutable'):
        raise ValueError('Cannot append a signature to an immutable release; publish a new revision')
    with tempfile.TemporaryDirectory(prefix='fansionia-release-') as temporary:
        subprocess.run(['gh', 'release', 'download', tag, '-R', repository,
                        '-p', '*.pkg.tar.zst', '-D', temporary], check=True)
        sign_directory(temporary, repository, tag)
        existing = {a['name'] for a in current['assets']}
        for signature in Path(temporary).glob('*.sig'):
            if signature.name not in existing:
                subprocess.run(['gh', 'release', 'upload', tag, str(signature), '-R', repository], check=True)
        actual = release(repository, tag)
        for path in Path(temporary).iterdir():
            match = next(a for a in actual['assets'] if a['name'] == path.name)
            if match.get('digest') != 'sha256:'+checksum(path):
                raise ValueError('Uploaded release digest mismatch')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['directory', 'backfill'])
    parser.add_argument('target')
    parser.add_argument('--repository', default=os.environ.get('GITHUB_REPOSITORY'))
    parser.add_argument('--tag', default='')
    arguments = parser.parse_args()
    if arguments.mode == 'backfill':
        backfill(arguments.repository, arguments.target)
    else:
        sign_directory(arguments.target, arguments.repository, arguments.tag)
