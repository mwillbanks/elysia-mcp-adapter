export interface Task {
  id: string
  title: string
  done: boolean
}

export function tasksFromResult(result: unknown): Task[] {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return []
  const tasks = result.structuredContent.tasks
  return Array.isArray(tasks) ? tasks.filter(isTask) : []
}

export function tasksFromInput(arguments_: unknown): Task[] | null {
  if (!isRecord(arguments_) || !Array.isArray(arguments_.tasks)) return null
  return arguments_.tasks.filter(isTask)
}

function isTask(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.done === 'boolean'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
