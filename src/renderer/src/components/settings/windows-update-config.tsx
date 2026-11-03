import { Button, Progress, Select, SelectItem, Switch } from '@heroui/react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { toast } from '@renderer/components/base/toast'
import {
  checkWindowsUpdate,
  downloadWindowsUpdate,
  installWindowsUpdate,
  windowsUpdateState
} from '@renderer/utils/ipc'
import type { WindowsUpdateState, WindowsUpdateSource } from '../../../../shared/windows-update'
import SettingItem from '../base/base-setting-item'

const WindowsUpdateConfig: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const [state, setState] = useState<WindowsUpdateState>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const unsubscribe = window.electron.ipcRenderer.on('windowsUpdateState', (_event, value) => {
      if (active) setState(value as WindowsUpdateState)
    })
    void windowsUpdateState()
      .then((value) => {
        if (active) setState(value)
      })
      .catch((error) => toast.error(String(error)))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const run = async (operation: () => Promise<WindowsUpdateState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await operation())
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusy(false)
    }
  }

  const working =
    busy ||
    state?.phase === 'checking' ||
    state?.phase === 'downloading' ||
    state?.phase === 'installing'
  const source = appConfig?.windowsUpdateSource === 'github' ? 'github' : 'cnb'
  return (
    <>
      <SettingItem title={t('windowsUpdate.source')} divider>
        <Select
          className="w-48"
          size="sm"
          aria-label={t('windowsUpdate.source')}
          disallowEmptySelection
          isDisabled={working}
          selectedKeys={[source]}
          onSelectionChange={(selection) => {
            const selected = [...selection][0] as WindowsUpdateSource
            if (selected === 'cnb' || selected === 'github')
              void patchAppConfig({ windowsUpdateSource: selected })
          }}
        >
          <SelectItem key="cnb">{t('windowsUpdate.sourceCnb')}</SelectItem>
          <SelectItem key="github">GitHub Release</SelectItem>
        </Select>
      </SettingItem>
      <SettingItem title={t('windowsUpdate.autoCheck')} divider>
        <Switch
          size="sm"
          aria-label={t('windowsUpdate.autoCheck')}
          isSelected={appConfig?.windowsAutoCheckUpdate !== false}
          onValueChange={(value) => void patchAppConfig({ windowsAutoCheckUpdate: value })}
        />
      </SettingItem>
      <SettingItem title={t('windowsUpdate.title')} divider>
        <Button
          size="sm"
          isLoading={state?.phase === 'checking'}
          isDisabled={working || state?.supported === false}
          onPress={() => void run(checkWindowsUpdate)}
        >
          {t('windowsUpdate.check')}
        </Button>
      </SettingItem>
      <div className="flex min-w-0 flex-col gap-3 pb-3 text-sm">
        <p className="text-default-500">{t('windowsUpdate.autoCheckHelp')}</p>
        {state && (
          <p>
            {t('windowsUpdate.current', {
              version: `${state.currentVersion}-${state.currentRevision}`
            })}
          </p>
        )}
        {state?.phase === 'idle' && state.checkedAt && (
          <p role="status">{t('windowsUpdate.upToDate')}</p>
        )}
        {state?.error && (
          <p role="alert" className="break-words text-danger">
            {state.error}
          </p>
        )}
        {state?.update && (
          <>
            <p role="status" className="font-medium">
              {t('windowsUpdate.availableBody', {
                version: `${state.update.version}-${state.update.revision}`
              })}
            </p>
            <p className="text-default-500">
              {t(state.portable ? 'windowsUpdate.portableHelp' : 'windowsUpdate.downloadHelp')}
            </p>
            {state.update.changelog && (
              <details className="min-w-0 rounded-lg bg-default-100 p-3">
                <summary className="cursor-pointer">{t('windowsUpdate.changelog')}</summary>
                <div className="markdown-body mt-2 break-words select-text">
                  <ReactMarkdown
                    allowedElements={[
                      'p',
                      'ul',
                      'ol',
                      'li',
                      'strong',
                      'em',
                      'code',
                      'pre',
                      'h1',
                      'h2',
                      'h3',
                      'h4',
                      'br',
                      'blockquote'
                    ]}
                    unwrapDisallowed
                  >
                    {state.update.changelog}
                  </ReactMarkdown>
                </div>
              </details>
            )}
            {state.phase === 'downloading' && (
              <Progress
                aria-label={t('windowsUpdate.downloading')}
                value={state.progress ?? 0}
                showValueLabel
                size="sm"
              />
            )}
            {state.phase === 'downloaded' && state.portable && (
              <p role="status">{t('windowsUpdate.portableSaved')}</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                color="primary"
                variant="flat"
                isDisabled={working}
                onPress={() => void run(downloadWindowsUpdate)}
              >
                {t('windowsUpdate.download')}
              </Button>
              {!state.portable && state.phase === 'downloaded' && (
                <Button
                  size="sm"
                  color="primary"
                  isDisabled={working}
                  onPress={() => void run(installWindowsUpdate)}
                >
                  {t('windowsUpdate.install')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}

export default WindowsUpdateConfig
