import { Divider } from '@heroui/react'
import React from 'react'

interface Props {
  title: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  divider?: boolean
}

const SettingItem: React.FC<Props> = (props) => {
  const { title, actions, children, divider = false } = props

  return (
    <>
      <div className="select-text min-h-8 w-full flex justify-between gap-4">
        <div className="min-h-8 flex items-start shrink-0">
          <h4 className="text-md leading-8 whitespace-nowrap">{title}</h4>
          <div>{actions}</div>
        </div>
        {children}
      </div>
      {divider && <Divider className="my-2" />}
    </>
  )
}

export default SettingItem
