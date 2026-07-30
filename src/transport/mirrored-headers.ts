import { isRecord } from '../internal.js'
import type { McpToolDefinition } from '../types.js'
import { decodeMcpHeaderValue, McpProtocolError } from './protocol.js'

interface MirroredHeader {
  headerName: string
  path: string[]
  type: 'boolean' | 'integer' | 'string'
}

const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u

export function assertMirroredToolHeaders(
  request: Request,
  tool: McpToolDefinition,
  argumentsValue: unknown
): void {
  const plan = mirroredHeaderPlan(tool.inputSchema)
  const args = isRecord(argumentsValue) ? argumentsValue : {}

  for (const item of plan) {
    const bodyValue = valueAtPath(args, item.path)
    const header = request.headers.get(`mcp-param-${item.headerName}`)
    if (bodyValue === undefined || bodyValue === null) {
      if (header !== null) throw headerMismatch(item.headerName)
      continue
    }
    if (header === null) throw headerMismatch(item.headerName)

    const decoded = decodeMcpHeaderValue(header, `Mcp-Param-${item.headerName}`)
    if (!matchesBodyValue(decoded, bodyValue, item.type)) {
      throw headerMismatch(item.headerName)
    }
  }
}

export function assertValidMirroredHeaderSchema(tool: McpToolDefinition): void {
  mirroredHeaderPlan(tool.inputSchema)
}

function mirroredHeaderPlan(schema: unknown): MirroredHeader[] {
  if (!isRecord(schema)) return []
  const result: MirroredHeader[] = []
  const names = new Set<string>()
  visitSchema(schema, [], true, result, names)
  return result
}

function visitSchema(
  schema: Record<string, unknown>,
  path: string[],
  reachable: boolean,
  result: MirroredHeader[],
  names: Set<string>
): void {
  if ('x-mcp-header' in schema) {
    result.push(validateAnnotation(schema, path, reachable, names))
  }

  const properties = schema.properties
  if (isRecord(properties)) {
    for (const [key, value] of Object.entries(properties)) {
      if (isRecord(value)) visitSchema(value, [...path, key], reachable, result, names)
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' || key === 'x-mcp-header') continue
    scanUnreachable(value, path, result, names)
  }
}

function validateAnnotation(
  schema: Record<string, unknown>,
  path: string[],
  reachable: boolean,
  names: Set<string>
): MirroredHeader {
  const name = schema['x-mcp-header']
  const type = schema.type
  if (
    !reachable ||
    path.length === 0 ||
    typeof name !== 'string' ||
    !HTTP_FIELD_NAME.test(name) ||
    (type !== 'boolean' && type !== 'integer' && type !== 'string')
  ) {
    throw new TypeError(`Invalid x-mcp-header annotation at ${formatPath(path)}`)
  }
  const normalizedName = name.toLowerCase()
  if (names.has(normalizedName)) {
    throw new TypeError(`Duplicate x-mcp-header annotation: ${name}`)
  }
  names.add(normalizedName)
  return { headerName: name, path, type }
}

function scanUnreachable(
  value: unknown,
  path: string[],
  result: MirroredHeader[],
  names: Set<string>
): void {
  if (Array.isArray(value)) {
    for (const item of value) scanUnreachable(item, path, result, names)
    return
  }
  if (!isRecord(value)) return
  visitSchema(value, path, false, result, names)
}

function valueAtPath(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function matchesBodyValue(header: string, body: unknown, type: MirroredHeader['type']): boolean {
  if (type === 'string') return typeof body === 'string' && header === body
  if (type === 'boolean') {
    return typeof body === 'boolean' && header === (body ? 'true' : 'false')
  }
  if (typeof body !== 'number' || !Number.isSafeInteger(body)) return false
  if (!JSON_NUMBER.test(header)) return false
  const parsed = Number(header)
  return Number.isSafeInteger(parsed) && parsed === body
}

function headerMismatch(name: string): McpProtocolError {
  return new McpProtocolError(-32020, `Mcp-Param-${name} header must match the tool arguments`, 400)
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? 'inputSchema' : `inputSchema.properties.${path.join('.properties.')}`
}
