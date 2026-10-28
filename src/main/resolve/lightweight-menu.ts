interface LightweightMenuActions {
  isActive: () => boolean
  enter: () => Promise<void>
  leave: () => void
  refresh: () => void
  onError: (error: unknown) => void
}

/** Native checkbox clicks toggle optimistically; always restore the actual lifecycle state. */
export function createLightweightMenuItem(
  label: string,
  accelerator: string,
  actions: LightweightMenuActions
): Electron.MenuItemConstructorOptions {
  return {
    id: 'quitWithoutCore',
    label,
    type: 'checkbox',
    checked: actions.isActive(),
    accelerator,
    click: async (): Promise<void> => {
      try {
        if (actions.isActive()) actions.leave()
        else await actions.enter()
      } catch (error) {
        actions.onError(error)
      } finally {
        actions.refresh()
      }
    }
  }
}
