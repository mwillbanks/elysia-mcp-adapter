type JsonRpcId = number

interface ToolResult {
  structuredContent?: {
    location?: string
    temperature?: number
    conditions?: string
  }
}

let requestId = 0
const pending = new Map<
  JsonRpcId,
  { resolve: (value: unknown) => void; reject: (reason: Error) => void }
>()

const locationElement = document.querySelector<HTMLElement>('#location')
const temperatureElement = document.querySelector<HTMLElement>('#temperature')
const conditionsElement = document.querySelector<HTMLElement>('#conditions')
const statusElement = document.querySelector<HTMLElement>('#status')
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh')

window.addEventListener('message', ({ data }) => {
  if (!isRecord(data)) return

  if (typeof data.id === 'number') {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if (isRecord(data.error)) request.reject(new Error(String(data.error.message)))
    else request.resolve(data.result)
    return
  }

  if (data.method === 'ui/notifications/tool-result' && isRecord(data.params)) {
    render(data.params as ToolResult)
  }
})

refreshButton?.addEventListener('click', async () => {
  if (refreshButton) refreshButton.disabled = true
  try {
    const result = (await callHost('tools/call', {
      name: 'weather.refresh',
      arguments: {}
    })) as ToolResult
    render(result)
  } finally {
    if (refreshButton) refreshButton.disabled = false
  }
})

void initialize()

async function initialize(): Promise<void> {
  await callHost('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'weather-vanilla', version: '1.0.0' },
    appCapabilities: {}
  })
  notifyHost('ui/notifications/initialized')
  if (statusElement) statusElement.textContent = 'Connected'
}

function callHost(method: string, params: unknown): Promise<unknown> {
  const id = ++requestId
  window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

function notifyHost(method: string, params?: unknown): void {
  window.parent.postMessage({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, '*')
}

function render(result: ToolResult): void {
  const weather = result.structuredContent
  if (!weather) return
  if (locationElement && weather.location) locationElement.textContent = weather.location
  if (temperatureElement && weather.temperature !== undefined) {
    temperatureElement.textContent = `${weather.temperature}°`
  }
  if (conditionsElement && weather.conditions) {
    conditionsElement.textContent = weather.conditions
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
