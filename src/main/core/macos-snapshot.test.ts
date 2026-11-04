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
  it('ignores unreferenced links and materializes referenced user resources', async () => {
    await writeFile(path.join(root, 'config.yaml'), '{}')
    await symlink('/etc/passwd', path.join(root, 'stolen'))
    const clean = await createMacCoreSnapshot(root, path.join(root, 'config.yaml'), '/protected')
    expect(clean.files).toEqual([])
    await writeFile(path.join(root, 'target.pem'), 'user certificate')
    await symlink(path.join(root, 'target.pem'), path.join(root, 'certificate.pem'))
    await writeFile(path.join(root, 'config.yaml'), 'tls:\n  certificate: certificate.pem\n')
    const snapshot = await createMacCoreSnapshot(root, path.join(root, 'config.yaml'), '/protected')
    expect(parse(snapshot.config)).toEqual({ tls: { certificate: '/protected/certificate.pem' } })
    expect(
      Buffer.from(
        snapshot.files.find((file) => file.path === 'certificate.pem')?.data || '',
        'base64'
      ).toString()
    ).toBe('user certificate')
  })

  it('imports external provider/certificate files and creates a new external database in protected storage', async () => {
    const external = await mkdtemp(path.join(tmpdir(), 'momo-resource-'))
    try {
      await writeFile(path.join(external, 'provider.yaml'), 'proxies: []')
      await writeFile(
        path.join(root, 'config.yaml'),
        `proxy-providers:\n  external:\n    type: file\n    path: ${external}/provider.yaml\ntraffic-history:\n  path: ${external}/history.db\n`
      )
      const snapshot = await createMacCoreSnapshot(
        root,
        path.join(root, 'config.yaml'),
        '/protected'
      )
      const config = parse<Record<string, Record<string, unknown>>>(snapshot.config)
      expect(config['traffic-history'].path).toMatch(/^\/protected\/imports\/.+\/history.db$/)
      expect(snapshot.files.find((file) => file.path.endsWith('/history.db'))).toMatchObject({
        data: '',
        importOnly: true
      })
      expect(snapshot.files.some((file) => file.path.endsWith('/provider.yaml'))).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })
})
