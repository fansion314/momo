import { readFileSync } from 'fs'
import { runInNewContext } from 'vm'
import { describe, expect, it } from 'vitest'

type Subject = { local: boolean; active: boolean; isInGroup: (group: string) => boolean }
type Action = { id: string; lookup: (key: string) => string | undefined }
type Rule = (action: Action, subject: Subject) => string | undefined

const actions = ['set-dns-servers', 'set-domains', 'set-default-route', 'revert'].map(
  (name) => `org.freedesktop.resolve1.${name}`
)

function loadRule(): Rule {
  let rule: Rule | undefined
  runInNewContext(readFileSync('packaging/arch/49-clash-momo-resolved.rules', 'utf8'), {
    polkit: { Result: { YES: 'yes' }, addRule: (value: Rule) => (rule = value) }
  })
  if (!rule) throw new Error('Polkit rule was not registered')
  return rule
}

describe('systemd-resolved polkit rule', () => {
  const rule = loadRule()
  const admin: Subject = { local: true, active: true, isInGroup: (group) => group === 'wheel' }
  const action = (id: string, iface: string): Action => ({
    id,
    lookup: (key) => (key === 'interface' ? iface : undefined)
  })

  it('permits only the four intended actions on the default interface', () => {
    for (const id of actions) {
      expect(rule(action(id, 'Mihomo'), admin)).toBe('yes')
      for (const iface of ['eth0', 'wlan0', 'custom-tun', '']) {
        expect(rule(action(id, iface), admin)).toBeUndefined()
      }
    }
    expect(rule(action('org.freedesktop.resolve1.flush-caches', 'Mihomo'), admin)).toBeUndefined()
  })

  it('does not authorize remote, inactive, or non-wheel subjects', () => {
    for (const subject of [
      { ...admin, local: false },
      { ...admin, active: false },
      { ...admin, isInGroup: () => false }
    ]) {
      expect(rule(action(actions[0], 'Mihomo'), subject)).toBeUndefined()
    }
  })
})
