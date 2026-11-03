import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'

const { coreTag } = JSON.parse(await readFile('packaging/macos/release.json', 'utf8'))
if (!/^mihomomo-v\d+\.\d+\.\d+-\d+$/.test(coreTag)) throw new Error('Invalid paired core tag')
const version = coreTag.slice('mihomomo-v'.length)
const filename = `mihomomo-${version}-windows-x64.zip`
const headers = { 'User-Agent': 'clash-momo-build', Accept: 'application/vnd.github+json' }
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
const response = await fetch(
  `https://api.github.com/repos/fansion314/momo/releases/tags/${coreTag}`,
  { headers }
)
if (!response.ok) throw new Error(`Paired core release ${coreTag}: HTTP ${response.status}`)
const release = await response.json()
if (release.draft || release.prerelease)
  throw new Error('Paired core must be a public stable release')
const asset = release.assets.find((item) => item.name === filename)
const checksumAsset = release.assets.find((item) => item.name === `${filename}.sha256`)
if (!asset || !checksumAsset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || ''))
  throw new Error('Paired core archive, GitHub digest and checksum are required')
async function download(item) {
  const result = await fetch(item.browser_download_url)
  if (!result.ok) throw new Error(`${item.name}: HTTP ${result.status}`)
  return Buffer.from(await result.arrayBuffer())
}
const archive = await download(asset)
const sha = createHash('sha256').update(archive).digest('hex')
const checksum = (await download(checksumAsset)).toString('utf8').trim()
if (
  `sha256:${sha}` !== asset.digest ||
  !new RegExp(`^${sha}\\s+\\*?${filename.replaceAll('.', '\\.')}\\s*$`).test(checksum)
)
  throw new Error('Paired core checksum mismatch')
const zip = new AdmZip(archive)
const binary = zip.readFile('mihomomo.exe')
const license = zip.readFile('LICENSE')
const manifest = JSON.parse(zip.readAsText('manifest.json'))
if (
  !binary ||
  !license ||
  manifest.tag !== coreTag ||
  manifest.architecture !== 'x64' ||
  manifest.version !== version.replace(/-\d+$/, '') ||
  !/^[a-f0-9]{40}$/.test(manifest.source_commit) ||
  createHash('sha256').update(binary).digest('hex') !== manifest.core_sha256
)
  throw new Error('Paired core manifest or binary mismatch')
await mkdir('extra/sidecar', { recursive: true })
await mkdir('extra/files/licenses', { recursive: true })
await writeFile('extra/sidecar/mihomomo.exe', binary)
await writeFile('extra/files/licenses/mihomomo.txt', license)
await writeFile('extra/files/mihomomo-manifest.json', JSON.stringify(manifest, null, 2) + '\n')
for (const entry of zip.getEntries()) {
  if (
    !entry.isDirectory &&
    /(?:license|notice)/i.test(entry.entryName) &&
    entry.entryName !== 'LICENSE'
  )
    await writeFile(
      `extra/files/licenses/mihomomo-${entry.entryName.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      entry.getData()
    )
}
console.log(`Verified and bundled ${coreTag} (${manifest.source_commit})`)
