import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parse, build } from 'plist'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('macOS packaging requires native Darwin ARM64')
}
const require = createRequire(import.meta.url)
const root = process.cwd()
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const release = JSON.parse(await readFile('packaging/macos/release.json', 'utf8'))
const run = (program, args, options = {}) =>
  execFileSync(program, args, { stdio: 'inherit', ...options })
const dist = path.join(root, 'dist/macos')
const app = path.join(dist, 'Clash Momo.app')
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
const electronDir = path.dirname(require.resolve('electron/package.json'))
run('/usr/bin/ditto', [path.join(electronDir, 'dist/Electron.app'), app])
const contents = path.join(app, 'Contents')
const resources = path.join(contents, 'Resources')
// Electron determines app.isPackaged from the executable basename, including
// helper processes. Rename the complete bundle family before signing it.
await rename(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS/Clash Momo'))
for (const [directory, suffix, identifier] of [
  ['Frameworks', ' Helper', 'helper'],
  ['Frameworks', ' Helper (Renderer)', 'helper'],
  ['Frameworks', ' Helper (GPU)', 'helper'],
  ['Frameworks', ' Helper (Plugin)', 'helper'],
  ['Frameworks', ' Helper EH', 'helper.EH'],
  ['Frameworks', ' Helper NP', 'helper.NP'],
  ['Library/LoginItems', ' Login Helper', 'loginhelper']
]) {
  const oldName = `Electron${suffix}`
  const newName = `Clash Momo${suffix}`
  const oldBundle = path.join(contents, directory, `${oldName}.app`)
  try {
    await access(oldBundle)
  } catch (error) {
    if (error.code === 'ENOENT') continue
    throw error
  }
  const helperInfoPath = path.join(oldBundle, 'Contents/Info.plist')
  const helperInfo = parse(await readFile(helperInfoPath, 'utf8'))
  await rename(
    path.join(oldBundle, 'Contents/MacOS', oldName),
    path.join(oldBundle, 'Contents/MacOS', newName)
  )
  Object.assign(helperInfo, {
    CFBundleExecutable: newName,
    CFBundleName: suffix === ' Helper' ? 'Clash Momo' : newName,
    CFBundleDisplayName: newName,
    CFBundleIdentifier: `world.fansionia.clash-momo.${identifier}`,
    CFBundleShortVersionString: pkg.version,
    CFBundleVersion: pkg.version
  })
  await writeFile(helperInfoPath, build(helperInfo))
  await rename(oldBundle, path.join(contents, directory, `${newName}.app`))
}
await rm(path.join(resources, 'default_app.asar'), { force: true })
const deployment = path.join(resources, 'app')
run('pnpm', [
  '--filter',
  'clash-momo',
  'deploy',
  '--ignore-scripts',
  '--legacy',
  '--prod',
  deployment
])
await cp('out', path.join(deployment, 'out'), { recursive: true })
await cp('resources', path.join(deployment, 'resources'), { recursive: true })
await cp('extra/files', path.join(resources, 'files'), { recursive: true })
await cp('extra/sidecar', path.join(resources, 'sidecar'), { recursive: true })
await cp('build/icon.icns', path.join(resources, 'clash-momo.icns'))
await mkdir(path.join(resources, 'files'), { recursive: true })
run(
  'go',
  [
    'build',
    '-buildvcs=false',
    '-trimpath',
    '-ldflags=-s -w',
    '-o',
    path.join(resources, 'files/world.fansionia.clash-momo.helper'),
    '.'
  ],
  {
    cwd: path.join(root, 'packaging/macos/helper')
  }
)
const infoPath = path.join(contents, 'Info.plist')
const info = parse(await readFile(infoPath, 'utf8'))
Object.assign(info, {
  CFBundleIdentifier: 'world.fansionia.clash-momo',
  CFBundleExecutable: 'Clash Momo',
  CFBundleName: 'Clash Momo',
  CFBundleDisplayName: 'Clash Momo',
  CFBundleShortVersionString: pkg.version,
  CFBundleVersion: pkg.version,
  MomoPackageRevision: release.revision,
  CFBundleIconFile: 'clash-momo.icns',
  LSMinimumSystemVersion: release.minimumOS,
  NSHighResolutionCapable: true,
  CFBundleURLTypes: [{ CFBundleURLName: 'Clash Momo', CFBundleURLSchemes: ['clash', 'mihomo'] }],
  CFBundleDocumentTypes: [
    {
      CFBundleTypeName: 'Clash Momo Plugin',
      CFBundleTypeExtensions: ['cpx'],
      CFBundleTypeRole: 'Viewer'
    }
  ]
})
delete info.ElectronAsarIntegrity
await writeFile(infoPath, build(info))
run('python3', ['packaging/macos/sign.py', app, path.join(root, 'build/entitlements.mac.plist')])
console.log(app)
