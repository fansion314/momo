import { isLocalProfile } from '../../../shared/local-config'
import { useProfileConfig } from './use-profile-config'

export function useActiveProfile(): {
  currentProfileItem: IProfileItem | undefined
  isLocalActive: boolean
} {
  const { profileConfig } = useProfileConfig()
  const currentProfileItem = profileConfig?.items.find((i) => i.id === profileConfig.current)
  return { currentProfileItem, isLocalActive: isLocalProfile(currentProfileItem) }
}
