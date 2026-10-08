import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import {
  MCP_SERVER_VARIANT_META_KEY,
  MCP_SERVER_VARIANTS_ID,
  type McpServerVariant,
  type McpVariantHints
} from '../extensions/variants/index.js'
import { isRecord } from '../internal.js'
import type { NormalizedMcpPluginOptions } from '../types.js'
import { variantSessions } from './variant-subscriptions.js'

export interface VariantSelectionRuntime {
  error: (code: number, message: string, data?: unknown) => Error
}

export function variantPrincipal(authorization?: McpAuthorizationContext): string | undefined {
  const principal = authorization?.principal
  return principal
    ? JSON.stringify([
        principal.issuer ?? null,
        principal.subject ?? null,
        principal.clientId ?? null
      ])
    : undefined
}

export function variantHints(
  params: Record<string, unknown>,
  runtime: VariantSelectionRuntime
): McpVariantHints | undefined {
  const capabilities = isRecord(params.capabilities) ? params.capabilities : undefined
  const extensions = isRecord(capabilities?.extensions) ? capabilities.extensions : undefined
  const payload = isRecord(extensions?.[MCP_SERVER_VARIANTS_ID])
    ? extensions[MCP_SERVER_VARIANTS_ID]
    : undefined
  const hints = isRecord(payload?.variantHints) ? payload.variantHints : undefined
  if (!hints) return undefined
  assertHintDescription(hints.description, runtime)
  if (hints.hints !== undefined && !validVariantHintRecord(hints.hints)) {
    throw runtime.error(-32602, 'Variant hints are invalid')
  }
  return hints as McpVariantHints
}

function assertHintDescription(value: unknown, runtime: VariantSelectionRuntime): void {
  if (value !== undefined && typeof value !== 'string') {
    throw runtime.error(-32602, 'Variant hints description must be a string')
  }
}

function validVariantHintRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.values(value).every(validVariantHintValue)
}

function validVariantHintValue(value: unknown): boolean {
  if (typeof value === 'string') return true
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export async function rankVariants(
  visible: readonly McpServerVariant[],
  hints: McpVariantHints | undefined,
  context: import('../types.js').McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpServerVariant[]> {
  const ids = await options.extensions.variants?.rank?.(visible, hints, context)
  if (!ids) return defaultVariantRanking(visible, hints?.hints ?? {})
  const known = new Map(visible.map((variant) => [variant.id, variant]))
  const invalid = new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))
  if (invalid) throw new TypeError('Variant rank callback returned invalid identifiers')
  return [
    ...ids.map((id) => known.get(id) as McpServerVariant),
    ...visible.filter((variant) => !ids.includes(variant.id))
  ]
}

function defaultVariantRanking(
  visible: readonly McpServerVariant[],
  requested: Record<string, string | string[]>
): McpServerVariant[] {
  return [...visible].sort(
    (left, right) =>
      variantScore(right, requested) - variantScore(left, requested) ||
      variantStatusRank(left) - variantStatusRank(right)
  )
}

function variantScore(variant: McpServerVariant, hints: Record<string, string | string[]>): number {
  let score = 0
  for (const [key, expected] of Object.entries(hints)) {
    const choices = Array.isArray(expected) ? expected : [expected]
    const index = choices.indexOf(variant.hints?.[key] ?? '')
    if (index >= 0) score += choices.length - index
  }
  return score
}

function variantStatusRank(variant: McpServerVariant): number {
  return (variant.status ?? 'stable') === 'stable' ? 0 : 1
}

export function publicVariant(variant: McpServerVariant): Record<string, unknown> {
  const { tools: _tools, resources: _resources, prompts: _prompts, ...value } = variant
  return value
}

export async function resolveActiveVariant(
  app: Parameters<typeof variantSessions>[0],
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: VariantSelectionRuntime
): Promise<{ variant: McpServerVariant; sessionId: string }> {
  const sessionId = request.headers.get('mcp-session-id')
  const session = sessionId ? variantSessions(app, options).get(sessionId) : undefined
  if (!session || session.principal !== variantPrincipal(authorization)) {
    throw runtime.error(-32602, 'Unknown MCP session')
  }
  const meta = isRecord(params._meta) ? params._meta : undefined
  const metadataSelector = meta?.[MCP_SERVER_VARIANT_META_KEY]
  if (metadataSelector !== undefined && typeof metadataSelector !== 'string') {
    throw runtime.error(-32602, 'Invalid server variant')
  }
  const requested =
    (metadataSelector as string | undefined) ??
    request.headers.get('mcp-server-variant') ??
    session.variants[0]?.id
  const variant = session.variants.find((candidate) => candidate.id === requested)
  if (!variant) {
    throw runtime.error(-32602, 'Invalid server variant', {
      requestedVariant: requested,
      availableVariants: session.variants.map(({ id }) => id)
    })
  }
  return { variant, sessionId: sessionId as string }
}

export function variantAllows(
  variant: McpServerVariant | undefined,
  kind: 'tools' | 'resources' | 'prompts',
  name: string
): boolean {
  if (!variant) return true
  const allowed = variant[kind]
  return !allowed || allowed.includes(name)
}
