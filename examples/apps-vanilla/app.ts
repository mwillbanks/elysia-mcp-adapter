type JsonRpcId = number
const HOST_REQUEST_TIMEOUT_MS = 30_000

interface ToolResult {
  structuredContent?: {
    location?: string
    temperature?: number
    conditions?: string
  }
}

let requestId = 0
let hostOrigin: string | undefined
const pending = new Map<
  JsonRpcId,
  {
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
    timeoutId: number
  }
>()

const locationElement = document.querySelector<HTMLElement>('#location')
const temperatureElement = document.querySelector<HTMLElement>('#temperature')
const conditionsElement = document.querySelector<HTMLElement>('#conditions')
const statusElement = document.querySelector<HTMLElement>('#status')
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh')

window.addEventListener('message', handleHostMessage)

function handleHostMessage(event: MessageEvent): void {
  const data = acceptedHostMessage(event)
  if (!data) return
  if (typeof data.id === 'number') {
    settleHostResponse(data, data.id)
    return
  }

  if (data.method === 'ui/notifications/tool-result' && isRecord(data.params)) {
    render(data.params)
  }
}

function acceptedHostMessage(event: MessageEvent): Record<string, unknown> | undefined {
  if (window.parent === window || event.source !== window.parent) return undefined
  if (!isRecord(event.data) || event.data.jsonrpc !== '2.0') return undefined
  if (hostOrigin !== undefined && event.origin !== hostOrigin) return undefined
  hostOrigin ??= event.origin
  return event.data
}

function settleHostResponse(data: Record<string, unknown>, id: number): void {
  const request = pending.get(id)
  if (!request) return
  const response = parseHostResponse(data)
  if (!response) return

  pending.delete(id)
  window.clearTimeout(request.timeoutId)
  if ('error' in response) request.reject(new Error(response.error))
  else request.resolve(response.result)
}

function parseHostResponse(
  data: Record<string, unknown>
): { result: unknown } | { error: string } | undefined {
  const hasResult = Object.hasOwn(data, 'result')
  const hasError = Object.hasOwn(data, 'error')
  if (hasResult === hasError) return undefined

  const errorMessage = hasError ? parseRpcError(data.error) : undefined
  if (hasError) return errorMessage === undefined ? undefined : { error: errorMessage }
  return { result: data.result }
}

function parseRpcError(value: unknown): string | undefined {
  if (!isRecord(value) || !Number.isInteger(value.code) || typeof value.message !== 'string') {
    return undefined
  }
  return value.message
}

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

void initialize().catch(() => {
  if (statusElement) statusElement.textContent = 'Connection failed'
})

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
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Host request timed out: ${method}`))
    }, HOST_REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timeoutId })
    try {
      postToHost({ jsonrpc: '2.0', id, method, params })
    } catch (error) {
      pending.delete(id)
      window.clearTimeout(timeoutId)
      reject(error)
    }
  })
}

function notifyHost(method: string, params?: unknown): void {
  postToHost({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
}

function postToHost(message: Record<string, unknown>): void {
  if (window.parent === window) throw new Error('MCP App must be embedded by a host')
  const targetOrigin = hostOrigin && hostOrigin !== 'null' ? hostOrigin : '*'
  window.parent.postMessage(message, targetOrigin)
}

function render(result: ToolResult | Record<string, unknown>): void {
  const weather = result.structuredContent
  if (!isRecord(weather)) return
  if (locationElement && typeof weather.location === 'string') {
    locationElement.textContent = weather.location
  }
  if (temperatureElement && typeof weather.temperature === 'number') {
    temperatureElement.textContent = `${weather.temperature}°`
  }
  if (conditionsElement && typeof weather.conditions === 'string') {
    conditionsElement.textContent = weather.conditions
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
