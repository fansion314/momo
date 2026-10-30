// Pinned public release assets; hashes deliberately fail closed if upstream replaces an asset.
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const platform = process.env.MOMO_RESOURCE_PLATFORM || `${process.platform}-${process.arch}`
const nativeAssets = {
  'linux-x64': [
    'sysproxy.linux-x64-gnu.node',
    '665048e01326bb71cc2059223cb107057ab744f09674cc711193e10eaf416f18'
  ],
  'darwin-arm64': [
    'sysproxy.darwin-arm64.node',
    'f379d2a153d81d8710707c861b0c62ff015953dda357979a94169f0a1b793e60'
  ]
}
const nativeAsset = nativeAssets[platform]
if (!nativeAsset) throw new Error(`Unsupported resource platform: ${platform}`)
const assets = [
  [
    `extra/sidecar/${nativeAsset[0]}`,
    `https://github.com/mihomo-party-org/sysproxy-rs-opti/releases/download/v0.1.3/${nativeAsset[0]}`,
    nativeAsset[1]
  ],
  [
    'extra/files/sub-store.bundle.cjs',
    'https://github.com/sub-store-org/Sub-Store/releases/download/2.44.2/sub-store.bundle.js',
    '8edbf4b5b47fc68a711790049625df7beac5bd1c8853f52e4d39d8f42dee494a'
  ],
  [
    'node_modules/.temp/substore.zip',
    'https://github.com/sub-store-org/Sub-Store-Front-End/releases/download/2.34.1/dist.zip',
    'b8116df45fe061987c9bce09d15adc8f8e311134e9105be040b94db43ebc433d'
  ],
  [
    'src/renderer/src/assets/NotoColorEmoji.ttf',
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/99701e07d3d1fe1bdbcdb14964547f0fd592966f/2D/fonts/NotoColorEmoji.ttf',
    '15671215ab769fdc7162a045d56fd7d7e477c51b04e6b3c761d914d8fdd6cc44'
  ],
  ...[
    [
      'country.mmdb',
      'country-lite.mmdb',
      'c8bc4d9a28f82db05c1bd1c8baa79caf067e812a70a34820027a81cb334f3e33'
    ],
    [
      'geoip.metadb',
      'geoip.metadb',
      'd49315d3fce861e014d6fda9aaca6d83a5b20e6f682f0bcee71a41afad047673'
    ],
    [
      'geosite.dat',
      'geosite.dat',
      'b4d3807aa45b4f5532ae236672f244a562452622483c0b489c63dd2aadaa821f'
    ],
    ['geoip.dat', 'geoip.dat', 'fbf747a085be25eb61ecac8c27140b4ab0bf8181af6fdb104caa325bd93cf117'],
    [
      'ASN.mmdb',
      'GeoLite2-ASN.mmdb',
      '3169b9ea7dad762f6837b95408dadc1173f47be33be2d83b6c90e67a57a7eb2e'
    ],
    [
      'BundleMRS.7z',
      'BundleMRS.7z',
      '9f566c14d4953f702ddda484a5052221c2c52ddaff494818c0b0556010f5e318'
    ]
  ].map(([file, name, hash]) => [
    `extra/files/${file}`,
    `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/${name}`,
    hash
  ])
]
await rm('extra/sidecar', { recursive: true, force: true })
for (const [file, url, expected] of assets) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`Checksum mismatch: ${url}`)
  await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  await writeFile(file, bytes)
}
await mkdir('extra/files/sub-store-frontend', { recursive: true })
execFileSync('unzip', [
  '-oq',
  'node_modules/.temp/substore.zip',
  '-d',
  'node_modules/.temp/substore'
])
execFileSync('cp', ['-a', 'node_modules/.temp/substore/dist/.', 'extra/files/sub-store-frontend/'])
