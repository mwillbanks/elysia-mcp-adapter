import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from './components/ui/button'
import { Card, CardContent, CardHeader } from './components/ui/card'
import './app.css'

interface Task {
  id: string
  title: string
  done: boolean
}

function App() {
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
        if (isRecord(input.arguments) && Array.isArray(input.arguments.tasks)) {
          setTasks(input.arguments.tasks.filter(isTask))
        }
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

  if (error) return <p role="alert">Could not connect: {error.message}</p>

  return (
    <Card>
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
          {isConnected ? `Connected · ${locale}` : 'Connecting'}
        </p>
        <h1 className="text-lg font-semibold">Today&apos;s tasks</h1>
        <p className="text-sm text-muted">
          Host mode: {displayMode}. Updates use an app-only same-server tool.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2">
          {tasks.length === 0 ? <li className="task">Waiting for tool input</li> : null}
          {tasks.map((task) => (
            <li className="task" data-done={task.done} key={task.id}>
              <input
                aria-label={`Mark ${task.title} ${task.done ? 'open' : 'done'}`}
                checked={task.done}
                disabled={saving}
                onChange={() => void toggleTask(task)}
                type="checkbox"
              />
              <span>{task.title}</span>
            </li>
          ))}
        </ul>
        <Button disabled={!isConnected} onClick={() => void toggleDisplayMode()}>
          {displayMode === 'inline' ? 'Expand' : 'Return inline'}
        </Button>
      </CardContent>
    </Card>
  )
}

function tasksFromResult(result: unknown): Task[] {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return []
  const tasks = result.structuredContent.tasks
  return Array.isArray(tasks) ? tasks.filter(isTask) : []
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

const root = document.querySelector('#root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
