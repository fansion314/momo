import BasePage from '@renderer/components/base/base-page'
import EmbeddedTrafficDashboard from '@renderer/components/traffic/embedded/dashboard'
import { useTranslation } from 'react-i18next'

export default function TrafficPage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <BasePage title={t('sider.cards.traffic')}>
      <EmbeddedTrafficDashboard />
    </BasePage>
  )
}
