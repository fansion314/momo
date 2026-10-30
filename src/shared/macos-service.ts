export interface MacServiceStatus {
  installed: boolean
  compatible: boolean
  protocol?: number
  helperHash?: string
  coreHash?: string
  coreVersion?: string
  running?: boolean
  workDir?: string
  uid?: number
  dataMigrated?: boolean
  error?: string
}
