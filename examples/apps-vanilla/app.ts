import { App } from '@modelcontextprotocol/ext-apps'
import { OriginBoundParentTransport } from './parent-transport.js'

const HOST_REQUEST_TIMEOUT_MS = 30_000

interface ToolResult {
  structuredContent?: {
    location?: string
    temperature?: number
    conditions?: string
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
  renderText(locationElement, weather.location)
  renderTemperature(weather.temperature)
  renderText(conditionsElement, weather.conditions)
}

function renderText(element: HTMLElement | null, value: unknown): void {
  if (element && typeof value === 'string') element.textContent = value
}

function renderTemperature(value: unknown): void {
  if (temperatureElement && typeof value === 'number') temperatureElement.textContent = `${value}°`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
