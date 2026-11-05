import { MCP_EXTENSION_SUPPORT } from '../manifest.js'
import { resolveGovernedDraftRevision } from '../revision-policy.js'
import type { TasksVersion, TasksVersionInput } from './types.js'

export const CURRENT_TASKS_VERSION: TasksVersion = MCP_EXTENSION_SUPPORT.tasks.current

export function resolveTasksVersion(version: TasksVersionInput = 'current'): TasksVersion {
  const { current, draft, historicalDrafts } = MCP_EXTENSION_SUPPORT.tasks
  if (version === 'current' || version === current) return current
  return resolveGovernedDraftRevision('tasks', version, {
    current: draft,
    superseded: Object.keys(historicalDrafts),
    migration: `Select "${current}" for the approved contract or adapt the integration to "${draft}".`
  })
}

export function taskCapabilityErrorCode(version: TasksVersionInput = 'current'): -32021 {
  resolveTasksVersion(version)
  return -32021
}
