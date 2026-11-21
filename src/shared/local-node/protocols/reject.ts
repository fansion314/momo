import type { LocalNodeType } from '../types'

export const reject: LocalNodeType = {
  type: 'reject',
  label: 'Reject',
  schemes: [],
  fields: [{ key: 'name', label: '名称', kind: 'text', required: true }]
}
