import type { McpInvocationContext } from '../../types.js'

export const MCP_SERVER_VARIANTS_ID = 'io.modelcontextprotocol/server-variants' as const
export const MCP_SERVER_VARIANT_META_KEY = 'io.modelcontextprotocol/server-variant' as const
export const MCP_SERVER_VARIANTS_REVISION = '53448f2fab9ac0fddf602db441245625b598ca4e' as const

export interface McpServerVariant {
  id: string
  description: string
  hints?: Record<string, string>
  status?: 'stable' | 'experimental' | 'deprecated'
  deprecationInfo?: { message: string; replacement?: string; removalDate?: string }
  tools?: readonly string[]
  resources?: readonly string[]
  prompts?: readonly string[]
}

export interface McpVariantHints {
  description?: string
  hints?: Record<string, string | string[]>
}
export interface McpVariantsOptions {
  version?: 'current' | typeof MCP_SERVER_VARIANTS_REVISION
  variants: readonly McpServerVariant[]
  visible?: (variant: McpServerVariant, context: McpInvocationContext) => boolean | Promise<boolean>
  rank?: (
    variants: readonly McpServerVariant[],
    hints: McpVariantHints | undefined,
    context: McpInvocationContext
  ) => readonly string[] | Promise<readonly string[]>
  discoveryLimit?: number
}
