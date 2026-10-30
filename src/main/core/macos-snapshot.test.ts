import { mkdtemp, writeFile, mkdir, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from '../utils/yaml'
import { createMacCoreSnapshot, rewriteManagedPaths } from './macos-snapshot'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'momo-snapshot-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('protected service snapshots', () => {
  it('rewrites only paths inside the exact source directory', () => {
    expect(
      rewriteManagedPaths(
        { path: '/user/work/a', list: ['/user/work2/a', '/user/work/../secret'] },
        '/user/work',
        '/protected'
      )
    ).toEqual({ path: '/protected/a', list: ['/user/work2/a', '/user/work/../secret'] })
  })
  it('imports binary state once and strips hooks/public controllers', async () => {
    const configPath = path.join(root, 'config.yaml')
    await writeFile(
      configPath,
      `traffic-history:\n  path: ${root}/traffic-history.db\nexternal-controller: :9090\npost-up: evil\n`
    )
    await writeFile(path.join(root, 'traffic-history.db'), Buffer.from([0, 255, 33]))
    await mkdir(path.join(root, 'providers'))
    await writeFile(path.join(root, 'providers', 'a.yaml'), 'proxies: []')
    const snapshot = await createMacCoreSnapshot(root, configPath, '/protected', 'AGE-SECRET-KEY')
    expect(parse(snapshot.config)).toEqual({
      'traffic-history': { path: '/protected/traffic-history.db' }
    })
    const state = snapshot.files.find((file) => file.path === 'traffic-history.db')
    if (!state) throw new Error('State missing')
    expect(state.importOnly).toBe(true)
    expect(Buffer.from(state.data, 'base64')).toEqual(Buffer.from([0, 255, 33]))
    expect(snapshot.files.some((file) => file.path === 'config.yaml')).toBe(false)
    const reload = await createMacCoreSnapshot(root, configPath, '/protected', undefined, true)
    expect(reload.files.map((file) => file.path)).toEqual(['providers/a.yaml'])
  })
  it('rejects symbolic links before reading privileged snapshot resources', async () => {
    await writeFile(path.join(root, 'config.yaml'), '{}')
    await symlink('/etc/passwd', path.join(root, 'stolen'))
    await expect(
      createMacCoreSnapshot(root, path.join(root, 'config.yaml'), '/protected')
    ).rejects.toThrow('symbolic links')
  })
  it('preserves the service-owned account path outside snapshot data and strips remote listeners', async () => {
    const configPath = path.join(root, 'config.yaml')
    await writeFile(
      configPath,
      `tizi-managed:\n  state-dir: /protected-service/tizi\nexternal-controller: 0.0.0.0:9090\nexternal-controller-tls: :9091\nexternal-controller-cors:\n  allow-origins: ['*']\nexternal-ui: dashboard\nexternal-ui-url: https://example.invalid/ui\nsecret: private-controller\n`
    )
    const snapshot = await createMacCoreSnapshot(root, configPath, '/protected-service/data')
    expect(parse(snapshot.config)).toEqual({
      'tizi-managed': { 'state-dir': '/protected-service/tizi' }
    })
    expect(snapshot.files).toEqual([])
    expect(snapshot.config).not.toContain('private-controller')
  })
})
