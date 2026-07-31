import type { TaskProvider, TaskProviderContext } from '../../../src/index.js'

export async function waitForCompletion(
  provider: Pick<TaskProvider, 'get'>,
  taskId: string,
  context: TaskProviderContext,
  label: string
): Promise<void> {
  const status = await pollStatus(provider, taskId, context, 200)
  if (status !== 'completed') throw new Error(`${label} smoke task ended as ${status}`)
}

async function pollStatus(
  provider: Pick<TaskProvider, 'get'>,
  taskId: string,
  context: TaskProviderContext,
  attemptsRemaining: number
): Promise<string> {
  const status = await readStatus(provider, taskId, context)
  if (status !== 'working') return status
  if (attemptsRemaining === 0) return status
  await Bun.sleep(10)
  return pollStatus(provider, taskId, context, attemptsRemaining - 1)
}

async function readStatus(
  provider: Pick<TaskProvider, 'get'>,
  taskId: string,
  context: TaskProviderContext
): Promise<string> {
  const task = await provider.get(taskId, context)
  if (!task) return 'missing'
  return task.status
}
