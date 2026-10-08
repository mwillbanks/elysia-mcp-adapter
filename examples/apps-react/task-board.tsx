import { Button } from './components/ui/button'
import { Card, CardContent, CardHeader } from './components/ui/card'
import type { Task } from './task-model'

interface TaskBoardProps {
  tasks: Task[]
  saving: boolean
  displayMode: string
  locale: string
  isConnected: boolean
  onToggleTask(task: Task): void
  onToggleDisplayMode(): void
}

export function TaskBoard(props: TaskBoardProps) {
  return (
    <Card>
      <TaskBoardHeader
        displayMode={props.displayMode}
        isConnected={props.isConnected}
        locale={props.locale}
      />
      <CardContent>
        <TaskList onToggle={props.onToggleTask} saving={props.saving} tasks={props.tasks} />
        <Button disabled={!props.isConnected} onClick={props.onToggleDisplayMode}>
          {props.displayMode === 'inline' ? 'Expand' : 'Return inline'}
        </Button>
      </CardContent>
    </Card>
  )
}

function TaskBoardHeader({
  displayMode,
  isConnected,
  locale
}: Pick<TaskBoardProps, 'displayMode' | 'isConnected' | 'locale'>) {
  return (
    <CardHeader>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
        {isConnected ? `Connected · ${locale}` : 'Connecting'}
      </p>
      <h1 className="text-lg font-semibold">Today&apos;s tasks</h1>
      <p className="text-sm text-muted">
        Host mode: {displayMode}. Updates use an app-only same-server tool.
      </p>
    </CardHeader>
  )
}

function TaskList({
  onToggle,
  saving,
  tasks
}: Pick<TaskBoardProps, 'tasks' | 'saving'> & { onToggle(task: Task): void }) {
  return (
    <ul className="grid gap-2">
      {tasks.length === 0 ? <li className="task">Waiting for tool input</li> : null}
      {tasks.map((task) => (
        <TaskRow key={task.id} onToggle={onToggle} saving={saving} task={task} />
      ))}
    </ul>
  )
}

function TaskRow({
  onToggle,
  saving,
  task
}: {
  task: Task
  saving: boolean
  onToggle(task: Task): void
}) {
  return (
    <li className="task" data-done={task.done}>
      <input
        aria-label={`Mark ${task.title} ${task.done ? 'open' : 'done'}`}
        checked={task.done}
        disabled={saving}
        onChange={() => onToggle(task)}
        type="checkbox"
      />
      <span>{task.title}</span>
    </li>
  )
}
