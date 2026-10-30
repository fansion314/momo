import { useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import type { MacServiceStatus } from '../../../../shared/macos-service'
import {
  macServiceStatus,
  installMacService,
  uninstallMacService,
  macServiceLogs
} from '../../utils/ipc'
import { toast } from '../base/toast'
import { tiziTestBuild } from '../../../../shared/test-build'

export default function MacosServiceConfig(): React.JSX.Element {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const [status, setStatus] = useState<MacServiceStatus>()
  const [logs, setLogs] = useState<string>()
  const [busy, setBusy] = useState(false)
  const refresh = async (): Promise<void> => setStatus(await macServiceStatus())
  useEffect(() => {
    void refresh().catch((error) => toast.error(String(error)))
  }, [])
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await operation()
      await refresh()
    } catch (error) {
      toast.error(String(error))
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  if (tiziTestBuild())
    return (
      <div role="status" className="py-3 border-b border-divider text-sm text-foreground-500">
        {zh
          ? '团购测试版使用随应用提供的独立内核与独立配置目录，不连接或更改已安装的 macOS 网络服务。'
          : 'This test build uses its own bundled core and profile, and does not connect to or change the installed macOS network service.'}
      </div>
    )
  return (
    <div className="py-3 border-b border-divider space-y-3">
      <div className="font-medium">{zh ? 'macOS 网络服务' : 'macOS network service'}</div>
      <div role="status" className="text-sm text-foreground-500">
        {!status
          ? zh
            ? '检查中…'
            : 'Checking…'
          : !status.installed
            ? zh
              ? '未安装 · 普通代理模式可用'
              : 'Not installed · Ordinary proxy mode available'
            : !status.compatible
              ? zh
                ? '需要更新服务或 Mihomomo'
                : 'Update the service or Mihomomo'
              : status.running
                ? zh
                  ? '已连接 · 内核运行中'
                  : 'Connected · Core running'
                : zh
                  ? '服务已安装 · 内核已停止'
                  : 'Installed · Core stopped'}
      </div>
      <p className="text-xs text-foreground-500">
        {zh
          ? 'TUN、系统代理和 DNS 由独立服务管理。安装或更新需要管理员授权；退出应用会停止内核并恢复网络设置。请先通过 Homebrew 安装 Mihomomo ≥ 1.19.33。'
          : 'The service manages TUN, system proxy and DNS. Installation and updates require administrator authorization. Quitting stops the core and restores network settings. Install Mihomomo ≥ 1.19.33 through Homebrew first.'}
      </p>
      {status?.coreVersion && <div className="text-xs">Mihomomo {status.coreVersion}</div>}
      <div className="flex gap-2 flex-wrap">
        <Button
          size="sm"
          color="primary"
          isLoading={busy}
          onPress={() => void run(installMacService)}
        >
          {status?.installed
            ? zh
              ? '更新服务'
              : 'Update service'
            : zh
              ? '安装服务'
              : 'Install service'}
        </Button>
        <Button size="sm" isDisabled={busy} onPress={() => void refresh()}>
          {zh ? '刷新状态' : 'Refresh status'}
        </Button>
        {status?.installed && (
          <Button
            size="sm"
            color="danger"
            variant="flat"
            isDisabled={busy}
            onPress={() => {
              if (
                window.confirm(
                  zh
                    ? '卸载服务将停止内核并恢复网络设置，保留服务数据。继续？'
                    : 'Uninstall the service, stop the core and restore network settings? Service data will be retained.'
                )
              )
                void run(uninstallMacService)
            }}
          >
            {zh ? '卸载服务' : 'Uninstall service'}
          </Button>
        )}
        {status?.compatible && (
          <Button
            size="sm"
            isDisabled={busy}
            onPress={() => void run(async () => setLogs(await macServiceLogs()))}
          >
            {zh ? '查看服务日志' : 'View service logs'}
          </Button>
        )}
      </div>
      {logs !== undefined && (
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap text-xs"
          aria-label={zh ? '服务日志' : 'Service logs'}
        >
          {logs || (zh ? '暂无日志' : 'No logs yet')}
        </pre>
      )}
    </div>
  )
}
