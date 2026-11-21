import { Button, CardBody, CardFooter, Chip, Progress } from '@heroui/react'
import { calcPercent, calcTraffic } from '@renderer/utils/calc'
import dayjs from '@renderer/utils/dayjs'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

/* eslint-disable react/prop-types */

interface Props {
  info: Pick<IProfileItem, 'name' | 'type' | 'updated' | 'extra'>
  isCurrent?: boolean
  actions: ReactNode
}

const ProfileCardContent: React.FC<Props> = (props) => {
  const { info, isCurrent = false, actions } = props
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { profileDisplayDate = 'expire' } = appConfig || {}
  const extra = info.extra
  const usage = (extra?.upload ?? 0) + (extra?.download ?? 0)
  const total = extra?.total ?? 0
  const typeChip =
    info.type === 'local'
      ? t('profiles.local')
      : info.type === 'remote' && !extra
        ? t('profiles.remote')
        : null
  return (
    <>
      <CardBody className="pb-1">
        <div className="flex justify-between h-8">
          <h3
            title={info?.name}
            className={`text-ellipsis whitespace-nowrap overflow-hidden text-md font-bold leading-8 ${isCurrent ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            {info?.name}
          </h3>
          {actions}
        </div>
        {info.type === 'remote' && extra && (
          <div
            className={`mt-2 flex justify-between ${isCurrent ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            <small>{`${calcTraffic(usage)}/${calcTraffic(total)}`}</small>
            {profileDisplayDate === 'expire' ? (
              <Button
                size="sm"
                variant="light"
                className={`h-5 p-1 m-0 ${isCurrent ? 'text-primary-foreground' : 'text-foreground'}`}
                onPress={async () => {
                  await patchAppConfig({ profileDisplayDate: 'update' })
                }}
              >
                {extra.expire
                  ? new Date(extra.expire * 1000).toLocaleDateString()
                  : t('profiles.neverExpire')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="light"
                className={`h-5 p-1 m-0 ${isCurrent ? 'text-primary-foreground' : 'text-foreground'}`}
                onPress={async () => {
                  await patchAppConfig({ profileDisplayDate: 'expire' })
                }}
              >
                {dayjs(info.updated).fromNow()}
              </Button>
            )}
          </div>
        )}
      </CardBody>
      <CardFooter className="pt-0">
        {typeChip && (
          <div
            className={`w-full mt-2 flex justify-between items-center ${isCurrent ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            <div className="flex gap-1">
              {typeChip && (
                <Chip
                  size="sm"
                  variant="bordered"
                  className={`${isCurrent ? 'text-primary-foreground border-primary-foreground' : 'border-primary text-primary'}`}
                >
                  {typeChip}
                </Chip>
              )}
            </div>
            {info.type === 'remote' && !extra && <small>{dayjs(info.updated).fromNow()}</small>}
          </div>
        )}
        {extra && (
          <Progress
            className="w-full"
            aria-label={t('profiles.trafficUsage')}
            classNames={{
              indicator: isCurrent ? 'bg-primary-foreground' : 'bg-foreground'
            }}
            value={calcPercent(extra?.upload, extra?.download, extra?.total)}
          />
        )}
      </CardFooter>
    </>
  )
}
export default ProfileCardContent
