import { isDeepStrictEqual } from 'util'
import {
  LOCAL_BUILTIN_OUTBOUNDS,
  type LocalDraft,
  type LocalObject
} from '../../shared/local-config'
import {
  getLocalNodeType,
  listRequiredLocalNodeFields,
  listLocalNodeFields,
  pruneLocalNode,
  readLocalNodeValue,
  writeLocalNodeValue
} from '../../shared/local-node'
import { parse, stringify } from '../utils/yaml'
import { isObject } from './compiler'
import { renameReferences } from './rename'

export function readLocalNodes(draft: LocalDraft): LocalObject[] {
  const nodes: unknown = parse(draft.modules.proxies)
  if (!Array.isArray(nodes) || !nodes.every(isObject)) {
    throw new Error('节点配置必须是对象列表')
  }
  return nodes
}

function writeLocalNodes(draft: LocalDraft, nodes: LocalObject[]): LocalDraft {
  return { ...draft, modules: { ...draft.modules, proxies: stringify(nodes) } }
}

function normalizeLocalNode(value: LocalObject): LocalObject {
  if (!isObject(value)) throw new Error('节点参数必须是对象')
  const type = value.type
  if (typeof type !== 'string' || !type.trim()) throw new Error('节点类型不能为空')
  const definition = getLocalNodeType(type)
  if (!definition) throw new Error(`未知节点类型：${type}`)
  let node = pruneLocalNode(structuredClone(value), type)
  const name = typeof node.name === 'string' ? node.name.trim() : ''
  if (!name) throw new Error('节点名称不能为空')
  if (LOCAL_BUILTIN_OUTBOUNDS.includes(name) || name === 'GLOBAL') {
    throw new Error(`不能使用内置出站或 GLOBAL 名称：${name}`)
  }
  node.name = name
  node.type = type
  for (const entry of listRequiredLocalNodeFields(type)) {
    const current = readLocalNodeValue(node, entry.path)
    if (current === undefined || current === null || current === '') {
      throw new Error(`${definition.label} 缺少必填项：${entry.field.label}`)
    }
  }
  for (const entry of listLocalNodeFields(type)) {
    const current = readLocalNodeValue(node, entry.path)
    if (current === undefined || current === null || current === '' || typeof current === 'boolean')
      continue
    if (entry.field.kind !== 'number') continue
    const number = Number(current)
    if (!Number.isFinite(number)) throw new Error(`${entry.field.label} 必须是数字`)
    if (
      entry.field.key === 'port' &&
      (!Number.isSafeInteger(number) || number < 1 || number > 65535)
    ) {
      throw new Error('端口必须是 1 到 65535 的整数')
    }
    if (typeof current === 'string') node = writeLocalNodeValue(node, entry.path, number)
  }
  return node
}

export function addLocalNodes(draft: LocalDraft, values: LocalObject[]): LocalDraft {
  const nodes = readLocalNodes(draft)
  const names = new Set(nodes.map((node) => String(node.name)))
  const added = values.map((value) => {
    const node = normalizeLocalNode(value)
    if (names.has(String(node.name))) throw new Error(`节点名称已存在：${node.name}`)
    names.add(String(node.name))
    return node
  })
  return writeLocalNodes(draft, [...nodes, ...added])
}

export function updateLocalNode(
  draft: LocalDraft,
  name: string,
  value: LocalObject,
  expected?: LocalObject
): LocalDraft {
  const nodes = readLocalNodes(draft)
  const index = nodes.findIndex((node) => node.name === name)
  if (index < 0) throw new Error(`节点 ${name} 已不存在，请重新打开编辑器`)
  if (expected && !isDeepStrictEqual(nodes[index], expected)) {
    throw new Error(`节点 ${name} 已被修改，请重新打开编辑器`)
  }
  const node = normalizeLocalNode(value)
  const nextName = String(node.name)
  if (nodes.some((item, i) => i !== index && item.name === nextName)) {
    throw new Error(`节点名称已存在：${nextName}`)
  }
  nodes[index] = node
  const next = writeLocalNodes(draft, nodes)
  return nextName === name ? next : renameReferences(next, name, nextName)
}

export function removeLocalNode(
  draft: LocalDraft,
  name: string,
  expected?: LocalObject
): LocalDraft {
  const nodes = readLocalNodes(draft)
  const current = nodes.find((node) => node.name === name)
  if (expected && (!current || !isDeepStrictEqual(current, expected))) {
    throw new Error(`节点 ${name} 已变化，请刷新后重新删除`)
  }
  return writeLocalNodes(
    draft,
    nodes.filter((node) => node.name !== name)
  )
}
