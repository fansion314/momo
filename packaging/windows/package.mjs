import { Arch, build, Platform } from 'electron-builder'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Windows packaging requires native Windows x64')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const revision = (await readFile('packaging/arch/PKGBUILD', 'utf8')).match(/^pkgrel=(\d+)$/m)[1]
const paired = JSON.parse(await readFile('extra/files/mihomomo-manifest.json', 'utf8'))
const core = await readFile('extra/sidecar/mihomomo.exe')
if (createHash('sha256').update(core).digest('hex') !== paired.core_sha256)
  throw new Error('Bundled core changed after verification')
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  config: 'electron-builder.windows.cjs'
})
const portable = 'dist/windows/portable'
await rm(portable, { recursive: true, force: true })
await cp('dist/windows/win-unpacked', portable, { recursive: true })
await writeFile(`${portable}/PORTABLE`, '')
const name = `clash-momo-${pkg.version}-${revision}-windows-x64`
await mkdir('dist/release', { recursive: true })
const zip = new AdmZip()
zip.addLocalFolder(portable)
await zip.writeZipPromise(`dist/release/${name}-portable.zip`)
await cp(`dist/windows/${name}-setup.exe`, `dist/release/${name}-setup.exe`)
const manifest = {
  tag: `clash-momo-v${pkg.version}-${revision}`,
  version: pkg.version,
  revision: Number(revision),
  architecture: 'x64',
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  core: paired,
  authenticode_signed: false
}
await writeFile(`dist/release/${name}-manifest.json`, JSON.stringify(manifest, null, 2) + '\n')
for (const suffix of ['-setup.exe', '-portable.zip', '-manifest.json']) {
  const file = name + suffix
  const sha = createHash('sha256')
    .update(await readFile(`dist/release/${file}`))
    .digest('hex')
  await writeFile(`dist/release/${file}.sha256`, `${sha}  ${file}\n`)
}
