export type LocalNodeFieldKind =
  'text' | 'password' | 'number' | 'bool' | 'select' | 'list' | 'map' | 'object'

export interface LocalNodeOption {
  value: string
  label?: string
}

export interface LocalNodeField {
  key: string
  label: string
  kind: LocalNodeFieldKind
  required?: boolean
  hidden?: boolean
  secret?: boolean
  options?: readonly (string | LocalNodeOption)[]
  default?: string | number | boolean
  placeholder?: string
  hint?: string
  unit?: string
  variantKey?: string
  variants?: Readonly<Record<string, readonly LocalNodeField[]>>
  children?: readonly LocalNodeField[]
}

export interface LocalNodeType {
  type: string
  label: string
  schemes: readonly string[]
  fields: readonly LocalNodeField[]
}
