/** UI lifecycle state is independent from core ownership and process lifetime. */
export class LightweightState {
  private active = false
  private revision = 0
  private listeners = new Set<(active: boolean) => void>()

  get isActive(): boolean {
    return this.active
  }

  requestEntry(): number {
    return ++this.revision
  }

  enterIfCurrent(revision: number): boolean {
    if (revision !== this.revision) return false
    this.setActive(true)
    return true
  }

  leave(): void {
    ++this.revision
    this.setActive(false)
  }

  subscribe(listener: (active: boolean) => void): () => void {
    this.listeners.add(listener)
    listener(this.active)
    return () => this.listeners.delete(listener)
  }

  private setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    for (const listener of this.listeners) listener(active)
  }
}

export const lightweightState = new LightweightState()
export const isLightweightMode = (): boolean => lightweightState.isActive
export const subscribeLightweightMode = (listener: (active: boolean) => void): (() => void) =>
  lightweightState.subscribe(listener)
