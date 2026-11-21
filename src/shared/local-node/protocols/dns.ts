import type { LocalNodeType } from '../types'

export const dns: LocalNodeType = {
  type: 'dns',
  label: 'DNS',
  schemes: [],
  fields: [{ key: 'name', label: '名称', kind: 'text', required: true }]
}
