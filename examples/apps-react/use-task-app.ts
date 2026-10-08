import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react'
import { useState } from 'react'
import { type Task, tasksFromInput, tasksFromResult } from './task-model'

export interface TaskAppState {
  tasks: Task[]
  saving: boolean
  displayMode: string
  locale: string
  isConnected: boolean
  error: Error | null
  toggleTask(task: Task): Promise<void>
  toggleDisplayMode(): Promise<void>
}

export function useTaskApp(): TaskAppState {
  const [tasks, setTasks] = useState<Task[]>([])
  const [saving, setSaving] = useState(false)
  const [displayMode, setDisplayMode] = useState('inline')
  const [locale, setLocale] = useState('unknown')
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'tasks-react', version: '1.0.0' },
    capabilities: {},
    autoResize: true,
    onAppCreated(created) {
      created.ontoolinput = (input) => {
        const incoming = tasksFromInput(input.arguments)
        if (incoming) setTasks(incoming)
      }
      created.ontoolresult = (result) => setTasks(tasksFromResult(result))
      created.onhostcontextchanged = (context) => {
        if (context.displayMode) setDisplayMode(context.displayMode)
        if (context.locale) setLocale(context.locale)
      }
      created.onteardown = async () => ({})
    }
  })

  useHostStyles(app, app?.getHostContext())

  async function toggleTask(task: Task): Promise<void> {
    if (!app) return
    setSaving(true)
    try {
      const result = await app.callServerTool({
        name: 'tasks.toggle',
        arguments: { id: task.id, done: !task.done }
      })
      setTasks(tasksFromResult(result))
    } finally {
      setSaving(false)
    }
  }

  async function toggleDisplayMode(): Promise<void> {
    if (!app) return
    const mode = displayMode === 'inline' ? 'fullscreen' : 'inline'
    const result = await app.requestDisplayMode({ mode })
    setDisplayMode(result.mode)
  }

  return {
    tasks,
    saving,
    displayMode,
    locale,
    isConnected,
    error,
    toggleTask,
    toggleDisplayMode
  }
}
