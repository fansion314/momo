import React, { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@renderer/components/base/toast'
import { Button, Input, Select, SelectItem, Switch } from '@heroui/react'
import { listWebdavBackups, webdavBackup, reinitWebdavBackupScheduler } from '@renderer/utils/ipc'
import debounce from '@renderer/utils/debounce'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useTranslation } from 'react-i18next'
import { isValidCron } from 'cron-validator'
import SettingItem from '../base/base-setting-item'
import SettingCard from '../base/base-setting-card'
import WebdavRestoreModal from './webdav-restore-modal'

const WebdavConfig: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const backupDisabled =
    typeof __TIZI_ENABLED__ !== 'undefined' && __TIZI_ENABLED__ && appConfig?.tiziActive === true
  const {
    webdavUrl,
    webdavUsername,
    webdavPassword,
    webdavDir = 'clash-party',
    webdavMaxBackups = 0,
    webdavBackupCron,
    webdavIgnoreCert = false
  } = appConfig || {}
  const [backuping, setBackuping] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [filenames, setFilenames] = useState<string[]>([])
  const [restoreOpen, setRestoreOpen] = useState(false)

  const [webdav, setWebdav] = useState({
    webdavUrl,
    webdavUsername,
    webdavPassword,
    webdavDir,
    webdavMaxBackups,
    webdavBackupCron,
    webdavIgnoreCert
  })
  const patchAppConfigRef = useRef(patchAppConfig)
  patchAppConfigRef.current = patchAppConfig
  const setWebdavDebounce = useMemo(
    () =>
      debounce(
        ({
          webdavUrl,
          webdavUsername,
          webdavPassword,
          webdavDir,
          webdavMaxBackups,
          webdavBackupCron
        }: typeof webdav) => {
          patchAppConfigRef.current({
            webdavUrl,
            webdavUsername,
            webdavPassword,
            webdavDir,
            webdavMaxBackups,
            webdavBackupCron
          })
        },
        500
      ),
    []
  )
  useEffect(() => () => setWebdavDebounce.cancel(), [setWebdavDebounce])

  useEffect(() => {
    if (backupDisabled) {
      setRestoreOpen(false)
      setWebdavDebounce.cancel()
    }
  }, [backupDisabled, setWebdavDebounce])

  const handleBackup = async (): Promise<void> => {
    setBackuping(true)
    try {
      await webdavBackup()
      new window.Notification(t('webdav.notification.backupSuccess.title'), {
        body: t('webdav.notification.backupSuccess.body')
      })
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBackuping(false)
    }
  }

  const handleRestore = async (): Promise<void> => {
    try {
      setRestoring(true)
      const filenames = await listWebdavBackups()
      setFilenames(filenames)
      setRestoreOpen(true)
    } catch (e) {
      toast.error(t('common.error.getBackupListFailed', { error: e }))
    } finally {
      setRestoring(false)
    }
  }
  return (
    <>
      {restoreOpen && (
        <WebdavRestoreModal filenames={filenames} onClose={() => setRestoreOpen(false)} />
      )}
      <SettingCard title={t('webdav.title')}>
        {backupDisabled && (
          <p role="status" className="px-2 py-2 text-sm text-warning">
            团购订阅使用期间已暂停 WebDAV 备份与同步，原有设置保留。
          </p>
        )}
        <SettingItem title={t('webdav.url')} divider>
          <Input
            isDisabled={backupDisabled}
            size="sm"
            className="w-[60%]"
            value={webdav.webdavUrl}
            onValueChange={(v) => {
              setWebdav({ ...webdav, webdavUrl: v })
              setWebdavDebounce({ ...webdav, webdavUrl: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('webdav.dir')} divider>
          <Input
            isDisabled={backupDisabled}
            size="sm"
            className="w-[60%]"
            value={webdav.webdavDir}
            onValueChange={(v) => {
              setWebdav({ ...webdav, webdavDir: v })
              setWebdavDebounce({ ...webdav, webdavDir: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('webdav.username')} divider>
          <Input
            isDisabled={backupDisabled}
            size="sm"
            className="w-[60%]"
            value={webdav.webdavUsername}
            onValueChange={(v) => {
              setWebdav({ ...webdav, webdavUsername: v })
              setWebdavDebounce({ ...webdav, webdavUsername: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('webdav.password')} divider>
          <Input
            isDisabled={backupDisabled}
            size="sm"
            className="w-[60%]"
            type="password"
            value={webdav.webdavPassword}
            onValueChange={(v) => {
              setWebdav({ ...webdav, webdavPassword: v })
              setWebdavDebounce({ ...webdav, webdavPassword: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('webdav.maxBackups')} divider>
          <Select
            isDisabled={backupDisabled}
            classNames={{ trigger: 'data-[hover=true]:bg-default-200' }}
            className="w-37.5"
            size="sm"
            selectedKeys={new Set([webdav.webdavMaxBackups.toString()])}
            aria-label={t('webdav.maxBackups')}
            onSelectionChange={(v) => {
              const value = Number.parseInt(Array.from(v)[0] as string, 10)
              setWebdav({ ...webdav, webdavMaxBackups: value })
              setWebdavDebounce({ ...webdav, webdavMaxBackups: value })
            }}
          >
            <SelectItem key="0">{t('webdav.noLimit')}</SelectItem>
            <SelectItem key="1">1</SelectItem>
            <SelectItem key="3">3</SelectItem>
            <SelectItem key="5">5</SelectItem>
            <SelectItem key="10">10</SelectItem>
            <SelectItem key="15">15</SelectItem>
            <SelectItem key="20">20</SelectItem>
          </Select>
        </SettingItem>
        <SettingItem title={t('webdav.ignoreCert')} divider>
          <Switch
            isDisabled={backupDisabled}
            size="sm"
            isSelected={webdav.webdavIgnoreCert}
            onValueChange={(v) => {
              setWebdav({ ...webdav, webdavIgnoreCert: v })
              patchAppConfig({ webdavIgnoreCert: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('webdav.backup.cron.title')} divider>
          <div className="flex w-[60%] gap-2">
            {webdavBackupCron !== webdav.webdavBackupCron && (
              <Button
                isDisabled={backupDisabled}
                size="sm"
                color="primary"
                onPress={async () => {
                  if (!webdav.webdavBackupCron || isValidCron(webdav.webdavBackupCron)) {
                    try {
                      await patchAppConfig({ webdavBackupCron: webdav.webdavBackupCron })
                      // 立即重新初始化调度器
                      await reinitWebdavBackupScheduler()
                      new Notification(t('webdav.notification.cronUpdated'))
                    } catch (error) {
                      console.error('Failed to update cron schedule:', error)
                      new Notification(t('webdav.notification.cronUpdateFailed'))
                    }
                  } else {
                    toast.warning(t('common.error.invalidCron'))
                  }
                }}
              >
                {t('common.confirm')}
              </Button>
            )}
            <Input
              isDisabled={backupDisabled}
              size="sm"
              value={webdav.webdavBackupCron}
              placeholder={t('webdav.backup.cron.placeholder')}
              onValueChange={(v) => {
                setWebdav({ ...webdav, webdavBackupCron: v })
              }}
            />
          </div>
        </SettingItem>
        <div className="flex justify-between">
          <Button
            isDisabled={backupDisabled}
            isLoading={backuping}
            fullWidth
            size="sm"
            className="mr-1"
            onPress={handleBackup}
          >
            {t('webdav.backup')}
          </Button>
          <Button
            isDisabled={backupDisabled}
            isLoading={restoring}
            fullWidth
            size="sm"
            className="ml-1"
            onPress={handleRestore}
          >
            {t('webdav.restore.title')}
          </Button>
        </div>
      </SettingCard>
    </>
  )
}

export default WebdavConfig
