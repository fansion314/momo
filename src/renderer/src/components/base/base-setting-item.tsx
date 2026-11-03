import { Divider } from '@heroui/react'
import React from 'react'

interface Props {
  title: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  divider?: boolean
  wrapTitle?: boolean
}

const SettingItem: React.FC<Props> = (props) => {
  const { title, actions, children, divider = false, wrapTitle = false } = props

  return (
    <>
      <div className="select-text min-h-8 w-full flex justify-between gap-4">
        <div
          className={`min-h-8 flex items-start ${wrapTitle ? 'min-w-0 max-w-[50%]' : 'shrink-0'}`}
        >
          <h4
            className={`text-md leading-8 ${wrapTitle ? 'break-words whitespace-normal' : 'whitespace-nowrap'}`}
          >
            {title}
          </h4>
          <div>{actions}</div>
        </div>
        {children}
      </div>
      {divider && <Divider className="my-2" />}
    </>
  )
}

export default SettingItem
