import { Button } from '@heroui/react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { platform } from '@renderer/utils/init'
import {
  closeMainWindow,
  getMainWindowState,
  minimizeMainWindow,
  setAlwaysOnTop,
  toggleMainWindowMaximized
} from '@renderer/utils/ipc'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiCheckboxBlankLine,
  RiCheckboxMultipleBlankLine,
  RiCloseLine,
  RiPushpin2Fill,
  RiPushpin2Line,
  RiSubtractLine
} from 'react-icons/ri'
import type { MainWindowState } from '../../../../shared/window'
import { toast } from './toast'

export default function WindowControls(): React.JSX.Element {
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const [state, setState] = useState<MainWindowState>({
    maximized: false,
    alwaysOnTop: false,
    supportsAlwaysOnTop: false
  })
  const [pending, setPending] = useState(false)
  const customControls = platform === 'linux' && !appConfig?.useWindowFrame
  const reportError = (error: unknown): void => toast.error(String(error))

  useEffect(() => {
    let mounted = true
    let receivedEvent = false
    const unsubscribe = window.electron.ipcRenderer.on('mainWindowStateChanged', (_, value) => {
      receivedEvent = true
      if (mounted) setState(value as MainWindowState)
    })
    void getMainWindowState()
      .then((value) => {
        if (mounted && !receivedEvent) setState(value)
      })
      .catch(reportError)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const pinTitle = t('common.pinWindow')
  const buttonClass = 'app-nodrag min-w-8 w-8 h-8 shrink-0'

  return (
    <div className="app-nodrag flex items-center gap-1 shrink-0">
      {state.supportsAlwaysOnTop && (
        <span title={pinTitle} className="inline-flex">
          <Button
            size="sm"
            className={buttonClass}
            isIconOnly
            aria-label={pinTitle}
            aria-pressed={state.alwaysOnTop}
            variant="light"
            color={state.alwaysOnTop ? 'primary' : 'default'}
            isDisabled={pending}
            onPress={async () => {
              setPending(true)
              try {
                setState(await setAlwaysOnTop(!state.alwaysOnTop))
              } catch (error) {
                reportError(error)
              } finally {
                setPending(false)
              }
            }}
          >
            {state.alwaysOnTop ? (
              <RiPushpin2Fill className="text-lg" />
            ) : (
              <RiPushpin2Line className="text-lg" />
            )}
          </Button>
        </span>
      )}
      {customControls && (
        <>
          <Button
            size="sm"
            className={buttonClass}
            isIconOnly
            title={t('common.minimizeWindow')}
            aria-label={t('common.minimizeWindow')}
            variant="light"
            onPress={() => void minimizeMainWindow().catch(reportError)}
          >
            <RiSubtractLine className="text-lg" />
          </Button>
          <Button
            size="sm"
            className={buttonClass}
            isIconOnly
            title={t(state.maximized ? 'common.restoreWindow' : 'common.maximizeWindow')}
            aria-label={t(state.maximized ? 'common.restoreWindow' : 'common.maximizeWindow')}
            variant="light"
            onPress={() => void toggleMainWindowMaximized().then(setState).catch(reportError)}
          >
            {state.maximized ? (
              <RiCheckboxMultipleBlankLine className="text-lg" />
            ) : (
              <RiCheckboxBlankLine className="text-lg" />
            )}
          </Button>
          <Button
            size="sm"
            className={buttonClass}
            isIconOnly
            title={t('common.closeWindow')}
            aria-label={t('common.closeWindow')}
            variant="light"
            color="danger"
            onPress={() => void closeMainWindow().catch(reportError)}
          >
            <RiCloseLine className="text-lg" />
          </Button>
        </>
      )}
    </div>
  )
}
