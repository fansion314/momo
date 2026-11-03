import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const [tag, directory] = process.argv.slice(2)
if (!tag || !directory) throw new Error('Usage: verify-release-assets.mjs TAG DIRECTORY')
const release = JSON.parse(
  execFileSync('gh', ['release', 'view', tag, '--json', 'isDraft,assets'], { encoding: 'utf8' })
)
if (!release.isDraft) throw new Error('Only a complete draft may be promoted')
const files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile())
if (files.length !== release.assets.length)
  throw new Error('Draft asset count differs from local release')
for (const file of files) {
  const asset = release.assets.find((entry) => entry.name === file.name)
  const bytes = await readFile(path.join(directory, file.name))
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (
    !asset ||
    asset.state !== 'uploaded' ||
    asset.size !== bytes.length ||
    asset.digest !== digest
  )
    throw new Error(`Draft asset is missing or differs: ${file.name}`)
}
console.log(`Verified ${files.length} uploaded draft assets against local bytes`)
