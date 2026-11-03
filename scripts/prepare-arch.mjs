// Pinned public release assets; hashes deliberately fail closed if upstream replaces an asset.
import { createHash } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'

// 2026-11-02 upstream release tree; immutable content URLs avoid latest asset repacks.
// All six SHA-256 values were checked against the upstream Release API digests.
const geoCommit = '1234686cec4ff41207931ee441a13ea4e26ebf13'

const platform = process.env.MOMO_RESOURCE_PLATFORM || `${process.platform}-${process.arch}`
const nativeAssets = {
  'win32-x64': [
    'sysproxy.win32-x64-msvc.node',
    'f292cf74413c8eaaf9d6d6ed95eec110226394f9a6c11ec00a749a830ddf7217'
  ],
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
      'c54a1704ee3e245bec1cb65c2e2948311eeee532e2ea1eed09322425d28775be'
    ],
    [
      'geosite.dat',
      'geosite.dat',
      '7297bf574a563aed8a69528e1f3a2bb275911fb83ebe3082494213d97ab09deb'
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
      '8f3208c5240732816bc73ec5db5c9828e6cedeeb47898aa9fc5bfd2e4b85164c'
    ]
  ].map(([file, name, hash]) => [
    `extra/files/${file}`,
    `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/${geoCommit}/${name}`,
    hash
  ])
]
await rm('extra/sidecar', { recursive: true, force: true })
async function downloadResource(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90000) })
      if (!response.ok) {
        const error = new Error(`${url}: HTTP ${response.status}`)
        if (response.status < 500 && response.status !== 429) throw error
        await response.body?.cancel()
        if (attempt === 3) throw error
      } else {
        return Buffer.from(await response.arrayBuffer())
      }
    } catch (error) {
      if (attempt === 3 || /HTTP 4(?!29)/.test(String(error))) throw error
    }
    console.warn(`Retrying resource download (${attempt}/3): ${url}`)
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
  }
  throw new Error(`Resource download failed: ${url}`)
}
for (const [file, url, expected] of assets) {
  console.log(`Preparing ${file}`)
  const bytes = await downloadResource(url)
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`Checksum mismatch: ${url}`)
  await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  await writeFile(file, bytes)
}
await mkdir('extra/files/sub-store-frontend', { recursive: true })
new AdmZip('node_modules/.temp/substore.zip').extractAllTo('node_modules/.temp/substore', true)
await cp('node_modules/.temp/substore/dist', 'extra/files/sub-store-frontend', { recursive: true })
