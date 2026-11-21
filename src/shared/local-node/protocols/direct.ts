import type { LocalNodeType } from '../types'

export const direct: LocalNodeType = {
  type: 'direct',
  label: 'Direct',
  schemes: [],
  fields: [{ key: 'name', label: '名称', kind: 'text', required: true }]
}
