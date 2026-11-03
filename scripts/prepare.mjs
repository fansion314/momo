// Fetch the platform's verified resources before its optional bundled core.
import './prepare-arch.mjs'

if ((process.env.MOMO_RESOURCE_PLATFORM || `${process.platform}-${process.arch}`) === 'win32-x64')
  await import('../packaging/windows/prepare-core.mjs')
