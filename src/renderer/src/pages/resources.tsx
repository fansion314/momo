import BasePage from '@renderer/components/base/base-page'
import GeoData from '@renderer/components/resources/geo-data'
import SmartModel from '@renderer/components/resources/smart-model'
import RuleProvider from '@renderer/components/resources/rule-provider'
import ProxyProvider from '@renderer/components/resources/proxy-provider'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useActiveProfile } from '@renderer/hooks/use-active-profile'
import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import EditModeMenu from '@renderer/components/local/edit-mode-menu'

const Resources: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const { core = 'mihomo' } = appConfig || {}
  const { isLocalActive: localMode } = useActiveProfile()
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!localMode) setEditing(false)
  }, [localMode])

  return (
    <BasePage
      title={t('sider.cards.resources')}
      header={localMode ? <EditModeMenu enabled={editing} onChange={setEditing} /> : undefined}
    >
      {core === 'mihomomo' && <SmartModel />}
      <GeoData />
      <ProxyProvider editing={localMode && editing} />
      <RuleProvider editing={localMode && editing} />
    </BasePage>
  )
}

export default Resources
