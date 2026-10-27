import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { app, dialog, ipcMain } from 'electron'
import { getControledMihomoConfig, patchControledMihomoConfig } from '../config'
import { mihomoCorePath } from '../utils/dirs'
import { managerLogger } from '../utils/logger'
import { checkAutoRun, enableAutoRun } from '../sys/autoRun'
import i18next from '../../shared/i18n'
import { checkAdminPrivileges } from './admin'

const execPromise = promisify(exec)
const execFilePromise = promisify(execFile)

// 内核名称白名单
const ALLOWED_CORES = ['mihomomo'] as const
type AllowedCore = (typeof ALLOWED_CORES)[number]
type StopCoreBeforeAdminRestart = (force?: boolean) => Promise<void>

let stopCoreBeforeAdminRestart: StopCoreBeforeAdminRestart | null = null

export function setStopCoreBeforeAdminRestart(stopCore: StopCoreBeforeAdminRestart): void {
  stopCoreBeforeAdminRestart = stopCore
}

export function isValidCoreName(core: string): core is AllowedCore {
  return ALLOWED_CORES.includes(core as AllowedCore)
}

export function validateCorePath(corePath: string): void {
  if (corePath !== '/usr/bin/mihomomo') {
    throw new Error('Invalid core path: only /usr/bin/mihomomo is supported')
  }
}

export const KERNEL_PERMISSIONS_MESSAGE =
  'The mihomomo package must install cap_net_admin, cap_net_raw and cap_net_bind_service on /usr/bin/mihomomo. Reinstall it with sudo pacman -S mihomomo. Clash Momo must run as your normal user.'

export function hasLinuxTunCapabilities(output: string): boolean {
  const prefix = '/usr/bin/mihomomo '
  const line = output.trim()
  if (!line.startsWith(prefix)) return false
  const capabilities = new Set<string>()
  for (const group of line.slice(prefix.length).trim().split(/\s+/)) {
    const match = group.match(/^((?:cap_[a-z_]+)(?:,cap_[a-z_]+)*)=([eip]+)$/)
    if (!match || !match[2].includes('e') || !match[2].includes('p')) continue
    for (const name of match[1].split(',')) capabilities.add(name)
  }
  return ['cap_net_admin', 'cap_net_raw', 'cap_net_bind_service'].every((capability) =>
    capabilities.has(capability)
  )
}

// 会话管理员状态缓存
let sessionAdminStatus: boolean | null = null

export async function initAdminStatus(): Promise<void> {
  if (process.platform === 'win32' && sessionAdminStatus === null) {
    sessionAdminStatus = await checkAdminPrivileges().catch(() => false)
  }
}

export function getSessionAdminStatus(): boolean {
  if (process.platform !== 'win32') {
    return true
  }
  return sessionAdminStatus ?? false
}

export { checkAdminPrivileges } from './admin'

export async function checkMihomoCorePermissions(): Promise<boolean> {
  try {
    const { stdout } = await execFilePromise('/usr/bin/getcap', [mihomoCorePath()], {
      timeout: 3000
    })
    return hasLinuxTunCapabilities(stdout)
  } catch {
    return false
  }
}

export async function checkHighPrivilegeCore(): Promise<boolean> {
  try {
    const corePath = mihomoCorePath()

    managerLogger.info(`Checking high privilege core: ${corePath}`)

    if (process.platform === 'win32') {
      if (!existsSync(corePath)) {
        managerLogger.info('Core file does not exist')
        return false
      }

      const hasHighPrivilegeProcess = await checkHighPrivilegeMihomoProcess()
      if (hasHighPrivilegeProcess) {
        managerLogger.info('Found high privilege mihomo process running')
        return true
      }

      const isAdmin = await checkAdminPrivileges()
      managerLogger.info(`Current process admin privileges: ${isAdmin}`)
      return isAdmin
    }

    if (process.platform === 'darwin' || process.platform === 'linux') {
      managerLogger.info('Non-Windows platform, skipping high privilege core check')
      return false
    }
  } catch (error) {
    managerLogger.error('Failed to check high privilege core', error)
    return false
  }

  return false
}

async function checkHighPrivilegeMihomoProcess(): Promise<boolean> {
  const mihomoExecutables = process.platform === 'win32' ? ['mihomomo.exe'] : ['mihomomo']

  try {
    if (process.platform === 'win32') {
      let stdout = ''
      try {
        const result = await execFilePromise('tasklist', ['/FO', 'CSV', '/NH'], {
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 4 * 1024 * 1024
        })
        stdout = result.stdout
      } catch (error) {
        managerLogger.error('Failed to list processes via tasklist', error)
        return false
      }

      const candidatePids: { pid: string; image: string }[] = []
      for (const line of stdout.split('\n')) {
        const match = line.match(/^"([^"]+)","(\d+)"/)
        if (!match) continue
        const image = match[1].toLowerCase()
        if (mihomoExecutables.includes(image)) {
          candidatePids.push({ pid: match[2], image })
        }
      }

      if (candidatePids.length === 0) {
        managerLogger.info('No mihomo processes found running')
        return false
      }

      managerLogger.info(`Found ${candidatePids.length} mihomo processes running`)

      const pidArgs = candidatePids.map(({ pid }) => pid).join(',')
      try {
        const { stdout: processInfo } = await execFilePromise(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Get-Process -Id ${pidArgs} -ErrorAction SilentlyContinue | Select-Object Name,Id,Path | ConvertTo-Json -Compress`
          ],
          { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }
        )

        if (!processInfo.trim()) return false

        const parsed = JSON.parse(processInfo)
        const list = Array.isArray(parsed) ? parsed : [parsed]
        for (const proc of list) {
          if (
            proc &&
            typeof proc.Name === 'string' &&
            proc.Name.toLowerCase() === 'mihomomo' &&
            proc.Path === null
          ) {
            return true
          }
        }
      } catch (error) {
        managerLogger.info('PowerShell process inspection failed', error)
      }
    } else {
      let foundProcesses = false

      for (const executable of mihomoExecutables) {
        try {
          const { stdout } = await execPromise(`ps aux | grep ${executable} | grep -v grep`)
          const lines = stdout
            .split('\n')
            .filter((line) => line.trim() && line.includes(executable))

          if (lines.length > 0) {
            foundProcesses = true
            managerLogger.info(`Found ${lines.length} ${executable} processes running`)

            for (const line of lines) {
              const parts = line.trim().split(/\s+/)
              if (parts.length >= 1) {
                const user = parts[0]
                managerLogger.info(`${executable} process running as user: ${user}`)

                if (user === 'root') {
                  return true
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }

      if (!foundProcesses) {
        managerLogger.info('No mihomo processes found running')
      }
    }
  } catch (error) {
    managerLogger.error('Failed to check high privilege mihomo process', error)
  }

  return false
}

// File ownership and capabilities belong to pacman, never the Electron runtime.
export async function grantTunPermissions(): Promise<void> {
  if (await checkMihomoCorePermissions()) return
  throw new Error(KERNEL_PERMISSIONS_MESSAGE)
}

export async function restartAsAdmin(forTun: boolean = true): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('This function is only available on Windows')
  }

  // 先停止 Core，避免新旧进程冲突
  try {
    managerLogger.info('Stopping core before admin restart...')
    await stopCoreBeforeAdminRestart?.(true)
    await new Promise((resolve) => setTimeout(resolve, 500))
  } catch (error) {
    managerLogger.warn('Failed to stop core before restart:', error)
  }

  const exePath = process.execPath
  const args = process.argv.slice(1).filter((arg) => arg !== '--admin-restart-for-tun')
  const restartArgs = forTun ? [...args, '--admin-restart-for-tun'] : args

  const escapedExePath = exePath.replace(/'/g, "''")
  const argsString = restartArgs.map((arg) => arg.replace(/'/g, "''")).join("', '")

  // 使用 Start-Sleep 延迟启动，确保旧进程完全退出后再启动新进程
  const command =
    restartArgs.length > 0
      ? `powershell -NoProfile -Command "Start-Sleep -Milliseconds 1000; Start-Process -FilePath '${escapedExePath}' -ArgumentList '${argsString}' -Verb RunAs"`
      : `powershell -NoProfile -Command "Start-Sleep -Milliseconds 1000; Start-Process -FilePath '${escapedExePath}' -Verb RunAs"`

  managerLogger.info('Restarting as administrator with command', command)

  // 先启动 PowerShell（它会等待 1 秒），然后立即退出当前进程
  exec(command, { windowsHide: true }, (error) => {
    if (error) {
      managerLogger.error('Failed to start PowerShell for admin restart', error)
    }
  })
  managerLogger.info('PowerShell command started, quitting app immediately')
  app.exit(0)
}

export async function requestTunPermissions(): Promise<void> {
  if (process.platform === 'win32') {
    await restartAsAdmin()
  } else {
    const hasPermissions = await checkMihomoCorePermissions()
    if (!hasPermissions) {
      await grantTunPermissions()
    }
  }
}

export async function showTunPermissionDialog(): Promise<boolean> {
  managerLogger.info('Preparing TUN permission dialog...')

  const title =
    process.platform === 'linux'
      ? 'mihomomo package permissions'
      : i18next.t('tun.permissions.title') || '需要管理员权限'
  const message =
    process.platform === 'linux'
      ? KERNEL_PERMISSIONS_MESSAGE
      : i18next.t('tun.permissions.message') ||
        '启用 TUN 模式需要管理员权限，是否现在重启应用获取权限？'
  const confirmText = i18next.t('common.confirm') || '确认'
  const cancelText = i18next.t('common.cancel') || '取消'

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title,
    message,
    buttons: [confirmText, cancelText],
    defaultId: 0,
    cancelId: 1
  })

  managerLogger.info(`TUN permission dialog choice: ${choice}`)
  return choice === 0
}

export async function showErrorDialog(title: string, message: string): Promise<void> {
  const okText = i18next.t('common.confirm') || '确认'

  dialog.showMessageBoxSync({
    type: 'error',
    title,
    message,
    buttons: [okText],
    defaultId: 0
  })
}

export async function validateTunPermissionsOnStartup(
  _restartCore: () => Promise<void>
): Promise<void> {
  const { tun } = await getControledMihomoConfig()

  if (!tun?.enable) {
    return
  }

  const hasPermissions = await checkMihomoCorePermissions()

  if (!hasPermissions) {
    // 启动时没有权限，静默禁用 TUN，不弹窗打扰用户
    managerLogger.warn(KERNEL_PERMISSIONS_MESSAGE)
    await patchControledMihomoConfig({ tun: { enable: false } })

    const { mainWindow } = await import('../index')
    mainWindow?.webContents.send('controledMihomoConfigUpdated')
    ipcMain.emit('updateTrayMenu')

    managerLogger.info('TUN auto-disabled due to insufficient permissions on startup')
  } else {
    managerLogger.info('TUN permissions validated successfully')
  }
}

export async function checkAdminRestartForTun(restartCore: () => Promise<void>): Promise<void> {
  if (process.argv.includes('--admin-restart-for-tun')) {
    managerLogger.info('Detected admin restart for TUN mode, auto-enabling TUN...')

    try {
      if (process.platform === 'win32') {
        const hasAdminPrivileges = await checkAdminPrivileges()
        if (hasAdminPrivileges) {
          await patchControledMihomoConfig({ tun: { enable: true }, dns: { enable: true } })

          const autoRunEnabled = await checkAutoRun()
          if (autoRunEnabled) {
            await enableAutoRun()
          }

          await restartCore()

          managerLogger.info('TUN mode auto-enabled after admin restart')

          const { mainWindow } = await import('../index')
          mainWindow?.webContents.send('controledMihomoConfigUpdated')
          ipcMain.emit('updateTrayMenu')
        } else {
          managerLogger.warn('Admin restart detected but no admin privileges found')
        }
      }
    } catch (error) {
      managerLogger.error('Failed to auto-enable TUN after admin restart', error)
    }
  } else {
    await validateTunPermissionsOnStartup(restartCore)
  }
}

export function checkTunPermissions(): Promise<boolean> {
  return checkMihomoCorePermissions()
}

export function manualGrantCorePermition(): Promise<void> {
  return grantTunPermissions()
}
