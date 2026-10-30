import { spawn } from 'child_process'
import { tiziNativeActions, type TiziNativeAction } from '../../shared/tizi'

const fields: Record<TiziNativeAction, readonly string[]> = {
  status: [],
  register: ['server_url', 'email'],
  'registration-status': ['server_url', 'request_id'],
  'complete-registration': ['server_url', 'email', 'code', 'password'],
  'reset-request': ['server_url', 'email'],
  'reset-confirm': ['server_url', 'email', 'code', 'password'],
  login: ['server_url', 'email', 'password', 'device_name'],
  logout: [],
  sync: [],
  refresh: [],
  usage: []
}

export function validateTiziRequest(
  action: unknown,
  input: unknown = {}
): { action: TiziNativeAction; payload: Record<string, string> } {
  if (!tiziNativeActions.includes(action as TiziNativeAction))
    throw new Error('Unknown tizi action')
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid tizi request')
  const name = action as TiziNativeAction
  const payload: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!fields[name].includes(key) || typeof value !== 'string' || value.length > 2048)
      throw new Error('Invalid tizi request field')
    payload[key] = value
  }
  if (payload.server_url !== undefined) {
    const url = new URL(payload.server_url)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Tizi service requires an HTTPS origin')
    payload.server_url = url.origin
  }
  if (payload.password !== undefined && payload.password.length > 128)
    throw new Error('Password is too long')
  if (payload.email !== undefined && payload.email.length > 254)
    throw new Error('Email is too long')
  return { action: name, payload }
}

/** Credentials travel through stdin, never process arguments or diagnostic logs. */
export async function invokeTiziNative(
  executable: string,
  stateDirectory: string,
  action: TiziNativeAction,
  payload: Record<string, string>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['tizi', '--state-dir', stateDirectory, action], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    let settled = false
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('Tizi service request timed out'))
    }, 60000)
    child.on('error', () => finish(new Error('Install a Mihomomo core with tizi support')))
    child.stdin.on('error', () => finish(new Error('Tizi native request could not be delivered')))
    // stderr is consumed without forwarding: native diagnostics may contain private data.
    child.stderr.on('data', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
        child.kill()
        finish(new Error('Tizi response exceeded the allowed size'))
      }
    })
    child.on('close', () => {
      if (settled) return
      try {
        const response = JSON.parse(output) as {
          ok?: boolean
          data?: unknown
          error?: { message?: string }
        }
        if (response.ok !== true)
          throw new Error(response.error?.message?.slice(0, 300) || 'Tizi native request failed')
        finish(undefined, response.data)
      } catch (error) {
        finish(
          error instanceof SyntaxError
            ? new Error('Install a Mihomomo core with tizi support')
            : (error as Error)
        )
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}
