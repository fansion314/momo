import { readFile, access } from 'fs/promises'
import { atomicWriteFile } from '../utils/safeFile'

export async function checkBackendBinding(
  markerPath: string,
  backend: string,
  otherLocalIdentity?: string
): Promise<void> {
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { backend?: string }
    if (typeof marker.backend !== 'string') throw new Error('Invalid tizi backend binding')
    if (marker.backend !== backend)
      throw new Error(
        '团购设备仍绑定在另一种内核运行方式；请恢复原方式完成上报，暂不支持自动迁移账本。'
      )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (otherLocalIdentity) {
      try {
        await access(otherLocalIdentity)
      } catch (accessError) {
        if ((accessError as NodeJS.ErrnoException).code === 'ENOENT') return
        throw accessError
      }
      throw new Error(
        '检测到普通内核模式的团购身份，请恢复原运行方式完成上报；不能自动切换至特权服务。'
      )
    }
  }
}

export async function rememberBackendBinding(markerPath: string, backend: string): Promise<void> {
  // Keep the binding after logout: the current settlement day may still need a later report.
  await atomicWriteFile(markerPath, JSON.stringify({ backend }), { mode: 0o600 })
}
