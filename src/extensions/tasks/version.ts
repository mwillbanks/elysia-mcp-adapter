import { MCP_EXTENSION_SUPPORT, resolvePinnedVersion } from '../manifest.js'
import type { TasksVersion, TasksVersionInput } from './types.js'

export const CURRENT_TASKS_VERSION: TasksVersion = MCP_EXTENSION_SUPPORT.tasks.current

export function resolveTasksVersion(version: TasksVersionInput = 'current'): TasksVersion {
  return resolvePinnedVersion(
    'tasks',
    version,
    MCP_EXTENSION_SUPPORT.tasks.current,
    MCP_EXTENSION_SUPPORT.tasks.versions
  )
}

export function taskCapabilityErrorCode(version: TasksVersionInput = 'current'): -32021 | -32003 {
  return resolveTasksVersion(version) === 'draft' ? -32003 : -32021
}
