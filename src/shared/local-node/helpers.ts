import type { LocalObject } from '../local-config'
import type { LocalNodeField, LocalNodeType } from './types'
import { LOCAL_NODE_COMMON_FIELDS } from './common'
import { LOCAL_NODE_PROTOCOLS } from './protocols'

export interface LocalNodeFieldEntry {
  field: LocalNodeField
  path: string
  labels: readonly string[]
  required: boolean
}

export function getLocalNodeType(type: string): LocalNodeType | undefined {
  return LOCAL_NODE_PROTOCOLS[type]
}

export function getLocalNodeFields(type: string): readonly LocalNodeField[] {
  return getLocalNodeType(type)?.fields ?? []
}

export function listLocalNodeFields(type: string): LocalNodeFieldEntry[] {
  const entries: LocalNodeFieldEntry[] = []
  const visit = (
    fields: readonly LocalNodeField[],
    prefix: string,
    labels: readonly string[]
  ): void => {
    for (const field of fields) {
      const path = prefix ? `${prefix}.${field.key}` : field.key
      const nextLabels = [...labels, field.label]
      entries.push({ field, path, labels: nextLabels, required: field.required === true })
      if (field.children?.length) visit(field.children, path, nextLabels)
    }
  }
  visit(getLocalNodeFields(type), '', [])
  visit(LOCAL_NODE_COMMON_FIELDS, '', [])
  return entries
}

export function listRequiredLocalNodeFields(type: string): LocalNodeFieldEntry[] {
  return listLocalNodeFields(type).filter((entry) => entry.required && !entry.field.hidden)
}

export function listOptionalLocalNodeFields(type: string): LocalNodeFieldEntry[] {
  return listLocalNodeFields(type).filter((entry) => !entry.required && !entry.field.hidden)
}

export interface LocalNodeOptionEntry {
  value: string
  label: string
}

export function listLocalNodeOptions(field: LocalNodeField): LocalNodeOptionEntry[] {
  return (field.options ?? []).map((option) =>
    typeof option === 'string'
      ? { value: option, label: option }
      : { value: option.value, label: option.label ?? option.value }
  )
}

export function listVisibleLocalNodeFields(type: string, added: readonly string[]): Set<string> {
  const paths = new Set(added)
  const ancestors = (path: string): string[] => {
    const parts = path.split('.')
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('.'))
  }
  const result = new Set<string>()
  for (const entry of listLocalNodeFields(type)) {
    if (entry.field.hidden) continue
    if (
      entry.required ||
      paths.has(entry.path) ||
      ancestors(entry.path).some((item) => paths.has(item)) ||
      added.some((item) => item.startsWith(`${entry.path}.`))
    ) {
      result.add(entry.path)
    }
  }
  return result
}

export function isLocalNodeValueEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

export function readLocalNodeValue(node: LocalObject, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = node
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as LocalObject)[segment]
  }
  return current
}

export function writeLocalNodeValue(node: LocalObject, path: string, value: unknown): LocalObject {
  const [head, ...rest] = path.split('.')
  if (!rest.length) {
    const next = { ...node }
    if (value === undefined) delete next[head]
    else next[head] = value
    return next
  }
  const child = node[head]
  const base = child !== null && typeof child === 'object' && !Array.isArray(child) ? child : {}
  return { ...node, [head]: writeLocalNodeValue(base as LocalObject, rest.join('.'), value) }
}

export function removeLocalNodeValue(node: LocalObject, path: string): LocalObject {
  const [head, ...rest] = path.split('.')
  if (!rest.length) {
    const next = { ...node }
    delete next[head]
    return next
  }
  const child = node[head]
  if (child === null || typeof child !== 'object' || Array.isArray(child)) return node
  const nextChild = removeLocalNodeValue(child as LocalObject, rest.join('.'))
  const next = { ...node }
  if (Object.keys(nextChild).length) next[head] = nextChild
  else delete next[head]
  return next
}

export function pruneLocalNode(node: LocalObject, type: string): LocalObject {
  const required = new Set(listRequiredLocalNodeFields(type).map((entry) => entry.path))
  const prune = (value: LocalObject, prefix: string): LocalObject => {
    const next: LocalObject = {}
    for (const [key, entry] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const child = prune(entry as LocalObject, path)
        if (Object.keys(child).length || required.has(path)) next[key] = child
        continue
      }
      if (required.has(path) || !isLocalNodeValueEmpty(entry)) next[key] = entry
    }
    return next
  }
  return prune(node, '')
}
