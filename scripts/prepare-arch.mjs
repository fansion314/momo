// Pinned public release assets; hashes deliberately fail closed if upstream replaces an asset.
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const assets = [
  [
    'extra/sidecar/sysproxy.linux-x64-gnu.node',
    'https://github.com/mihomo-party-org/sysproxy-rs-opti/releases/download/v0.1.3/sysproxy.linux-x64-gnu.node',
    '665048e01326bb71cc2059223cb107057ab744f09674cc711193e10eaf416f18'
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
      '2a89256bba8c292abe1fc8b8e04d92a4aac6f5aa948284db5da2aff85e7543f3'
    ],
    [
      'geoip.metadb',
      'geoip.metadb',
      'f74179989befc93862f7bad4e32ac2ef2e1073b99b5c40483ec8007387df7362'
    ],
    [
      'geosite.dat',
      'geosite.dat',
      'c57333596b44aa061e84c3c224e97a4475c759a5e3baab1fcda002e48b4dc313'
    ],
    ['geoip.dat', 'geoip.dat', 'a6271d3c96361d96156e6d3f7cf1550ef21b00d2f951deb772f464db91e89ac5'],
    [
      'ASN.mmdb',
      'GeoLite2-ASN.mmdb',
      '4f480469576dba3e84b1f5c17313059982b70a62b8d35fb1ed225e39109b0531'
    ],
    [
      'BundleMRS.7z',
      'BundleMRS.7z',
      '7b589fc21774aa42c7f17d618635081e0de6a5e80f47a96ea3ba0b318da36f7f'
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
