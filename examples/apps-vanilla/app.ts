import {
  type JSONRPCMessage,
  parseJSONRPCMessage,
  type Transport,
  type TransportSendOptions
} from '@modelcontextprotocol/client'
import { App } from '@modelcontextprotocol/ext-apps'

const HOST_REQUEST_TIMEOUT_MS = 30_000

interface ToolResult {
  structuredContent?: {
    location?: string
    temperature?: number
    conditions?: string
  }
}

/**
 * MCP Apps v2 transport with parent-window validation and first-valid-origin
 * pinning. Opaque iframe origins still require `*` when sending.
 */
class OriginBoundParentTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private hostOrigin?: string
  private started = false

  private readonly receive = (event: MessageEvent): void => {
    if (event.source !== window.parent) return
    if (this.hostOrigin !== undefined && event.origin !== this.hostOrigin) return
    try {
      const message = parseJSONRPCMessage(event.data)
      this.hostOrigin ??= event.origin
      this.onmessage?.(message)
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP Apps transport is already started')
    if (window.parent === window) throw new Error('MCP App must be embedded by a host')
    this.started = true
    window.addEventListener('message', this.receive)
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.started) throw new Error('MCP Apps transport is not started')
    const targetOrigin = this.hostOrigin && this.hostOrigin !== 'null' ? this.hostOrigin : '*'
    window.parent.postMessage(message, targetOrigin)
  }

  async close(): Promise<void> {
    if (!this.started) return
    this.started = false
    window.removeEventListener('message', this.receive)
    this.onclose?.()
  }
}

const locationElement = document.querySelector<HTMLElement>('#location')
const temperatureElement = document.querySelector<HTMLElement>('#temperature')
const conditionsElement = document.querySelector<HTMLElement>('#conditions')
const statusElement = document.querySelector<HTMLElement>('#status')
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh')

const app = new App(
  { name: 'weather-vanilla', version: '1.0.0' },
  {},
  { autoResize: true, strict: true }
)
app.ontoolresult = render

refreshButton?.addEventListener('click', async () => {
  if (refreshButton) refreshButton.disabled = true
  try {
    const result = await app.callServerTool(
      { name: 'weather.refresh', arguments: {} },
      { timeout: HOST_REQUEST_TIMEOUT_MS }
    )
    render(result)
  } finally {
    if (refreshButton) refreshButton.disabled = false
  }
})

void app
  .connect(new OriginBoundParentTransport(), { timeout: HOST_REQUEST_TIMEOUT_MS })
  .then(() => {
    if (statusElement) statusElement.textContent = 'Connected'
  })
  .catch(() => {
    if (statusElement) statusElement.textContent = 'Connection failed'
  })

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
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
