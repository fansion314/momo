import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkBackendBinding, rememberBackendBinding } from './backend-binding'

let directory: string
let marker: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'momo-tizi-binding-'))
  marker = path.join(directory, 'backend.json')
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

describe('tizi backend ownership', () => {
  it('rejects switching away from the enrolled state directory without rewriting the binding', async () => {
    await checkBackendBinding(marker, '/local/tizi')
    await rememberBackendBinding(marker, '/local/tizi')
    await expect(checkBackendBinding(marker, '/local/tizi')).resolves.toBeUndefined()
    await expect(checkBackendBinding(marker, '/privileged/tizi')).rejects.toThrow('另一种')
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ backend: '/local/tizi' })
  })

  it('detects an existing pre-marker local identity instead of silently enrolling a privileged device', async () => {
    const oldIdentity = path.join(directory, 'identity.enc')
    await writeFile(oldIdentity, 'encrypted existing identity')
    await expect(checkBackendBinding(marker, '/privileged/tizi', oldIdentity)).rejects.toThrow(
      '普通内核模式'
    )
    await expect(checkBackendBinding(marker, '/local/tizi')).resolves.toBeUndefined()
  })

  it('fails closed for a corrupt marker', async () => {
    await writeFile(marker, 'broken-json')
    await expect(checkBackendBinding(marker, '/local/tizi')).rejects.toThrow()
    expect(await readFile(marker, 'utf8')).toBe('broken-json')
  })
})
