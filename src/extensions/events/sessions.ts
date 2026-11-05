import { notifyRegistryChange } from '../../state.js'
import type { AnyElysiaApp } from '../../types.js'

/** Notify eligible subscriptions after an external event provider changes its catalog. */
export function notifyMcpEventListChanged(app: AnyElysiaApp): void {
  notifyRegistryChange(app, 'events')
}
