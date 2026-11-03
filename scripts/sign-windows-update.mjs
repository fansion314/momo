import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function assetRecord(directory, name) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk)
  return { name, size: (await stat(path.join(directory, name))).size, sha256: hash.digest('hex') }
}

export function signManifest(payload, privatePem, keys, keyId = 'momo-windows-2026') {
  const key = createPrivateKey(privatePem)
  const publicDer = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
  if (key.asymmetricKeyType !== 'ed25519' || keys[keyId] !== publicDer)
    throw new Error('Update signing key does not match the embedded trusted public key')
  const bytes = Buffer.from(JSON.stringify(payload))
  return {
    schema: 1,
    keyId,
    payload: bytes.toString('base64'),
    signature: sign(null, bytes, key).toString('base64')
  }
}

async function main() {
  const [tag, directory] = process.argv.slice(2)
  const match = tag?.match(/^clash-momo-v(\d+\.\d+\.\d+)-([1-9]\d*)$/)
  if (!match || !directory) throw new Error('Usage: sign-windows-update.mjs CLIENT_TAG DIRECTORY')
  const version = match[1]
  const revision = Number(match[2])
  const base = `clash-momo-${version}-${revision}-windows-x64`
  const build = JSON.parse(await readFile(path.join(directory, `${base}-manifest.json`), 'utf8'))
  const release = JSON.parse(await readFile('packaging/macos/release.json', 'utf8'))
  const keys = JSON.parse(await readFile('src/shared/windows-update-keys.json', 'utf8'))
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (
    build.tag !== tag ||
    build.version !== version ||
    build.revision !== revision ||
    build.architecture !== 'x64' ||
    build.core.tag !== release.coreTag ||
    build.source_commit !== sourceCommit ||
    !/^[a-f0-9]{40}$/.test(build.source_commit) ||
    !/^[a-f0-9]{40}$/.test(build.core.source_commit) ||
    !/^[a-f0-9]{64}$/.test(build.core.core_sha256)
  )
    throw new Error('Windows build provenance does not match the release')
  const payload = {
    schema: 1,
    product: 'clash-momo',
    platform: 'win32',
    arch: 'x64',
    tag,
    version,
    revision,
    publishedAt: new Date().toISOString(),
    changelog: await readFile('packaging/windows/release-notes.md', 'utf8'),
    sourceCommit: build.source_commit,
    core: {
      tag: build.core.tag,
      sha256: build.core.core_sha256,
      sourceCommit: build.core.source_commit
    },
    assets: {
      installer: await assetRecord(directory, `${base}-setup.exe`),
      portable: await assetRecord(directory, `${base}-portable.zip`)
    }
  }
  const envelope = signManifest(payload, process.env.WINDOWS_UPDATE_SIGNING_KEY, keys)
  const name = 'clash-momo-windows-x64-update.json'
  await writeFile(path.join(directory, name), JSON.stringify(envelope, null, 2) + '\n')
  const { sha256 } = await assetRecord(directory, name)
  await writeFile(path.join(directory, name + '.sha256'), `${sha256}  ${name}\n`)
  console.log(`Signed Windows update manifest for ${tag}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
