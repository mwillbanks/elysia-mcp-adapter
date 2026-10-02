import type { HTTPMethod } from 'elysia'
import type { NormalizedMcpPluginOptions } from './types.js'

export const MCP_STATE_SYMBOL = Symbol.for('@mwillbanks/elysia-mcp-adapter.state')

export const DEFAULT_MCP_PATH = '/mcp'
export const DEFAULT_PROTOCOL_VERSION = '2026-07-28'
export const LEGACY_PROTOCOL_VERSION = '2025-11-25'

export const MCP_CORE_CAPABILITIES = {
  completions: 'completions',
  elicitation: 'elicitation',
  logging: 'logging',
  prompts: 'prompts',
  resources: 'resources',
  roots: 'roots',
  sampling: 'sampling',
  tools: 'tools'
} as const

export const DEFAULT_ALLOWED_ROUTES = '*' as const
export const DEFAULT_EXCLUDED_ROUTES = [] as const
export const INTERNAL_EXCLUDED_ROUTES = [
  '/mcp',
  '/mcp/*',
  '/openapi',
  '/openapi/*',
  '/swagger',
  '/swagger/*',
  '/scalar',
  '/scalar/*'
] as const

export const DEFAULT_HTTP_METHODS: HTTPMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export const DEFAULT_PASS_THROUGH_HEADERS = ['authorization', 'cookie', 'x-api-key']
export const DEFAULT_ALLOW_TOOL_INPUT_HEADERS: string[] = []

export const DEFAULT_MARSHAL: NormalizedMcpPluginOptions['marshal'] = {
  maxTextBytes: 256 * 1024,
  maxStructuredBytes: 256 * 1024,
  includeHttpMetadata: true,
  binary: 'error'
}

export const JSON_SCHEMA_EMPTY_OBJECT = {
  type: 'object',
  additionalProperties: false
} as const
