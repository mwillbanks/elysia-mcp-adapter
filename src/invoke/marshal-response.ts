import { isRecord } from '../internal.js'
import type {
  McpContent,
  McpPromptMessage,
  McpPromptResult,
  McpResourceContent,
  McpResourceReadResult,
  McpResponseMarshalOptions,
  McpToolResult,
  NormalizedMcpPluginOptions
} from '../types.js'

export async function marshalHttpResponseToToolResult(
  response: Response,
  routeLabel: string,
  options: NormalizedMcpPluginOptions,
  override?: McpResponseMarshalOptions
): Promise<McpToolResult> {
  const marshal = { ...options.marshal, ...(override ?? {}) }
  const parsed = await readResponse(response, marshal)
  const httpMetadata = marshal.includeHttpMetadata
    ? {
        status: response.status,
        statusText: response.statusText,
        headers: safeHeaders(response.headers)
      }
    : undefined

  if (!response.ok) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `HTTP ${response.status} from ${routeLabel}\n\n${parsed.text}`.trim()
        }
      ],
      structuredContent: {
        ...(httpMetadata ? { http: httpMetadata } : {}),
        error: parsed.structured ?? parsed.text
      }
    }
  }

  if (parsed.binaryContent) {
    return {
      content: [parsed.binaryContent],
      structuredContent: httpMetadata ? { http: httpMetadata } : undefined
    }
  }

  const result: McpToolResult = {
    content: [{ type: 'text', text: parsed.text }]
  }

  if (parsed.structured !== undefined) {
    result.structuredContent = parsed.structured
  }

  if (httpMetadata) result._meta = { http: httpMetadata }

  return result
}

export async function marshalHttpResponseToResourceResult(
  response: Response,
  uri: string,
  options: NormalizedMcpPluginOptions,
  override?: McpResponseMarshalOptions
): Promise<McpResourceReadResult> {
  const marshal = { ...options.marshal, ...(override ?? {}) }
  const parsed = await readResponse(response, marshal)
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'text/plain'

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while reading resource ${uri}: ${parsed.text}`)
  }

  if (parsed.binaryResource) {
    return { contents: [{ ...parsed.binaryResource, uri, mimeType }] }
  }

  return {
    contents: [
      {
        uri,
        mimeType,
        text: parsed.text
      }
    ]
  }
}

export async function marshalHttpResponseToPromptResult(
  response: Response,
  options: NormalizedMcpPluginOptions,
  override?: McpResponseMarshalOptions
): Promise<McpPromptResult> {
  const marshal = { ...options.marshal, ...(override ?? {}) }
  const parsed = await readResponse(response, marshal)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while retrieving prompt: ${parsed.text}`)
  }

  return coercePromptResult(parsed.structured ?? parsed.text)
}

export function coerceToolResult(value: unknown): McpToolResult {
  if (isToolResult(value)) return value

  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] }
  }

  if (value instanceof Response) {
    throw new Error('Response values must be marshalled by route-backed invocation')
  }

  return {
    content: [
      {
        type: 'text',
        text: stringifyForText(value)
      }
    ],
    structuredContent: value
  }
}

export function coerceResourceResult(
  value: unknown,
  uri: string,
  mimeType?: string
): McpResourceReadResult {
  if (isResourceReadResult(value)) return value

  if (Array.isArray(value) && value.every(isResourceContent)) {
    return { contents: value }
  }

  if (isResourceContent(value)) return { contents: [value] }

  if (typeof value === 'string') {
    return {
      contents: [
        {
          uri,
          mimeType: mimeType ?? 'text/plain',
          text: value
        }
      ]
    }
  }

  return {
    contents: [
      {
        uri,
        mimeType: mimeType ?? 'application/json',
        text: stringifyForText(value)
      }
    ]
  }
}

export function coercePromptResult(value: unknown): McpPromptResult {
  if (isPromptResult(value)) return value

  if (Array.isArray(value) && value.every(isPromptMessage)) {
    return { messages: value }
  }

  if (typeof value === 'string') {
    return {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: value }
        }
      ]
    }
  }

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: stringifyForText(value)
        }
      }
    ]
  }
}

export function createValidationToolError(issues: unknown): McpToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Invalid tool input:\n${stringifyForText(issues)}`
      }
    ],
    structuredContent: {
      code: 'MCP_INPUT_VALIDATION_FAILED',
      issues
    }
  }
}

function stringifyForText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function readResponse(
  response: Response,
  marshal: Required<McpResponseMarshalOptions>
): Promise<{
  text: string
  structured?: unknown
  binaryContent?: McpContent
  binaryResource?: McpResourceContent
}> {
  const contentType = response.headers.get('content-type') ?? ''
  const mimeType = contentType.split(';')[0] || 'application/octet-stream'

  if (isBinaryMimeType(mimeType)) {
    if (marshal.binary === 'error') {
      return {
        text: `Binary response omitted. mimeType=${mimeType}`,
        structured: {
          omittedBinary: true,
          mimeType
        }
      }
    }

    const buffer = await response.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')

    if (mimeType.startsWith('image/')) {
      return {
        text: `[binary image: ${mimeType}; ${buffer.byteLength} bytes]`,
        binaryContent: { type: 'image', data: base64, mimeType },
        binaryResource: { uri: '', blob: base64, mimeType }
      }
    }

    if (mimeType.startsWith('audio/')) {
      return {
        text: `[binary audio: ${mimeType}; ${buffer.byteLength} bytes]`,
        binaryContent: { type: 'audio', data: base64, mimeType },
        binaryResource: { uri: '', blob: base64, mimeType }
      }
    }

    return {
      text: `[binary data: ${mimeType}; ${buffer.byteLength} bytes]`,
      binaryResource: { uri: '', blob: base64, mimeType }
    }
  }

  const rawText = await response.text()
  const text = truncateUtf8(rawText, marshal.maxTextBytes)

  if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
    try {
      const structured = JSON.parse(rawText)
      return {
        text: truncateUtf8(stringifyForText(structured), marshal.maxTextBytes),
        structured: limitStructured(structured, marshal.maxStructuredBytes)
      }
    } catch {
      return { text }
    }
  }

  return { text }
}

function safeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  const denied = new Set(['authorization', 'cookie', 'set-cookie'])

  for (const [key, value] of headers.entries()) {
    if (!denied.has(key.toLowerCase())) result[key] = value
  }

  return result
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.byteLength <= maxBytes) return text
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[truncated ${buffer.byteLength - maxBytes} bytes]`
}

function limitStructured(value: unknown, maxBytes: number): unknown {
  const text = stringifyForText(value)
  if (Buffer.byteLength(text) <= maxBytes) return value

  return {
    truncated: true,
    bytes: Buffer.byteLength(text),
    excerpt: truncateUtf8(text, maxBytes)
  }
}

function isBinaryMimeType(mimeType: string): boolean {
  if (!mimeType) return false
  if (mimeType.startsWith('text/')) return false
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) return false
  if (mimeType === 'application/xml' || mimeType.endsWith('+xml')) return false
  if (mimeType === 'application/x-www-form-urlencoded') return false

  return (
    mimeType === 'application/octet-stream' ||
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    mimeType.startsWith('application/')
  )
}

function isToolResult(value: unknown): value is McpToolResult {
  return isRecord(value) && Array.isArray(value.content)
}

function isResourceReadResult(value: unknown): value is McpResourceReadResult {
  return isRecord(value) && Array.isArray(value.contents)
}

function isResourceContent(value: unknown): value is McpResourceContent {
  return isRecord(value) && typeof value.uri === 'string' && ('text' in value || 'blob' in value)
}

function isPromptResult(value: unknown): value is McpPromptResult {
  return isRecord(value) && Array.isArray(value.messages)
}

function isPromptMessage(value: unknown): value is McpPromptMessage {
  return (
    isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    isRecord(value.content)
  )
}
