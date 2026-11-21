import { isDeepStrictEqual } from 'util'
import type { LocalDraft, LocalObject } from '../../shared/local-config'
import { parse, stringify } from '../utils/yaml'
import { isObject } from './compiler'
import { renameReferences } from './rename'

export function readLocalGroups(draft: LocalDraft): LocalObject[] {
  const groups: unknown = parse(draft.modules['proxy-groups'])
  if (!Array.isArray(groups) || !groups.every(isObject)) {
    throw new Error('代理组配置必须是对象列表')
  }
  return groups
}

export function updateLocalGroup(
  draft: LocalDraft,
  name: string,
  value: LocalObject,
  expected?: LocalObject
): LocalDraft {
  const groups = readLocalGroups(draft)
  const index = groups.findIndex((group) => group.name === name)
  if (index < 0) throw new Error(`代理组 ${name} 已不存在，请重新打开编辑器`)
  if (expected && !isDeepStrictEqual(groups[index], expected)) {
    throw new Error(`代理组 ${name} 已被修改，请重新打开编辑器`)
  }
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('代理组名称不能为空')
  const nextName = value.name.trim()
  if (groups.some((group, i) => i !== index && group.name === nextName)) {
    throw new Error(`代理组名称已存在: ${nextName}`)
  }
  groups[index] = { ...structuredClone(value), name: nextName }
  const next = { ...draft, modules: { ...draft.modules, 'proxy-groups': stringify(groups) } }
  return nextName === name ? next : renameReferences(next, name, nextName)
}

export function addLocalGroup(draft: LocalDraft, value: LocalObject): LocalDraft {
  const groups = readLocalGroups(draft)
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('代理组名称不能为空')
  const name = value.name.trim()
  if (groups.some((group) => group.name === name)) throw new Error(`代理组名称已存在: ${name}`)
  return {
    ...draft,
    modules: {
      ...draft.modules,
      'proxy-groups': stringify([...groups, { ...structuredClone(value), name }])
    }
  }
}

export function reorderLocalGroups(draft: LocalDraft, names: string[]): LocalDraft {
  const groups = readLocalGroups(draft)
  if (
    names.length !== groups.length ||
    new Set(names).size !== names.length ||
    groups.some((group) => typeof group.name !== 'string' || !names.includes(group.name))
  ) {
    throw new Error('代理组列表已变化，请刷新后重新排序')
  }
  const byName = new Map(groups.map((group) => [group.name, group]))
  return {
    ...draft,
    modules: { ...draft.modules, 'proxy-groups': stringify(names.map((name) => byName.get(name))) }
  }
}

export function removeLocalGroup(
  draft: LocalDraft,
  name: string,
  expected?: LocalObject
): LocalDraft {
  const groups = readLocalGroups(draft)
  const current = groups.find((group) => group.name === name)
  if (expected && (!current || !isDeepStrictEqual(current, expected)))
    throw new Error(`代理组 ${name} 已变化，请刷新后重新删除`)
  return {
    ...draft,
    modules: {
      ...draft.modules,
      'proxy-groups': stringify(groups.filter((group) => group.name !== name))
    }
  }
}
