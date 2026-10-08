import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app.css'
import { TaskBoard } from './task-board'
import { useTaskApp } from './use-task-app'

function App() {
  const state = useTaskApp()
  if (state.error) return <p role="alert">Could not connect: {state.error.message}</p>
  return (
    <TaskBoard
      displayMode={state.displayMode}
      isConnected={state.isConnected}
      locale={state.locale}
      onToggleDisplayMode={() => void state.toggleDisplayMode()}
      onToggleTask={(task) => void state.toggleTask(task)}
      saving={state.saving}
      tasks={state.tasks}
    />
  )
}

const root = document.querySelector('#root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
