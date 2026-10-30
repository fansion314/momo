import { execFile } from 'child_process'
import { promisify } from 'util'
import { connectMacService, isMacServiceActive, macServiceRequest } from './macos-service'

interface DNSOperationOptions {
  force?: boolean
  timeout?: number
}
export async function getDefaultDevice(): Promise<string> {
  const { stdout } = await promisify(execFile)('/sbin/route', ['-n', 'get', 'default'], {
    timeout: 3000
  })
  const device = stdout
    .split('\n')
    .find((line) => line.includes('interface:'))
    ?.trim()
    .split(/\s+/)[1]
  if (!device) throw new Error('Get device failed')
  return device
}
export async function setPublicDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (!(await connectMacService())) throw new Error('Install the macOS service before changing DNS')
  await macServiceRequest('/v1/network/dns', { enabled: true, servers: ['223.5.5.5'] })
}
export async function recoverDNS(options: DNSOperationOptions = {}): Promise<void> {
  if (process.platform !== 'darwin' || !isMacServiceActive()) return
  await macServiceRequest('/v1/network/dns', { enabled: false }, options.timeout)
}
