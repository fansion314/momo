const fs = require('node:fs')
const pkg = require('./package.json')
const revision = fs.readFileSync('packaging/arch/PKGBUILD', 'utf8').match(/^pkgrel=(\d+)$/m)[1]
module.exports = {
  appId: 'world.fansionia.clash-momo',
  productName: 'Clash Momo',
  executableName: 'Clash Momo',
  directories: { buildResources: 'build', output: 'dist/windows' },
  files: ['out/**', 'resources/**', 'package.json', '!resources/extra/**'],
  extraResources: [
    { from: 'extra', to: '', filter: ['files/**', 'sidecar/**'] },
    { from: 'LICENSE', to: 'files/licenses/clash-momo.txt' }
  ],
  asar: true,
  npmRebuild: false,
  publish: null,
  protocols: [{ name: 'Clash Momo URI Scheme', schemes: ['clash', 'mihomo'] }],
  fileAssociations: [{ ext: 'cpx', name: 'Clash Momo Plugin', role: 'Viewer' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    requestedExecutionLevel: 'asInvoker',
    signAndEditExecutable: true
  },
  nsis: {
    artifactName: `clash-momo-${pkg.version}-${revision}-windows-x64-setup.exe`,
    uninstallDisplayName: 'Clash Momo',
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    include: 'build/installer.nsh'
  }
}
