import { Divider } from '@heroui/react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { platform } from '@renderer/utils/init'
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import WindowControls from './window-controls'

interface Props {
  title?: React.ReactNode
  header?: React.ReactNode
  children?: React.ReactNode
  contentClassName?: string
}

const BasePage = forwardRef<HTMLDivElement, Props>((props, ref) => {
  const { appConfig } = useAppConfig()
  const { useWindowFrame = false } = appConfig || {}
  const [overlayWidth, setOverlayWidth] = React.useState(0)

  useEffect(() => {
    if (platform === 'win32' && !useWindowFrame) {
      try {
        // @ts-ignore windowControlsOverlay
        const windowControlsOverlay = window.navigator.windowControlsOverlay
        setOverlayWidth(window.innerWidth - windowControlsOverlay.getTitlebarAreaRect().width)
      } catch {
        // ignore
      }
    }
  }, [useWindowFrame])

  const contentRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => {
    return contentRef.current as HTMLDivElement
  })

  return (
    <div ref={contentRef} className="w-full h-full">
      <div className="sticky top-0 z-40 h-12.25 w-full bg-background">
        <div className="app-drag p-2 flex justify-between h-12">
          <div className="title min-w-0 h-full truncate whitespace-nowrap text-lg leading-8">
            {props.title}
          </div>
          <div style={{ marginRight: overlayWidth }} className="header flex gap-1 h-full shrink-0">
            {props.header}
            <WindowControls />
          </div>
        </div>

        <Divider />
      </div>
      <div className="content h-[calc(100vh-49px)] overflow-y-auto custom-scrollbar">
        {props.children}
      </div>
    </div>
  )
})

BasePage.displayName = 'BasePage'
export default BasePage
