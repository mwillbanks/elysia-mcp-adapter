export const MCP_ACTION_METADATA_ID = 'io.modelcontextprotocol/action-metadata' as const
export const MCP_TRUST_ANNOTATIONS_ID = 'io.modelcontextprotocol/trust-annotations' as const
export const MCP_TOOL_ANNOTATIONS_REVISION = 'fecace78a9552f70ba735d750fc3c4b190e20429' as const

export interface McpActionMetadata {
  inputMetadata?: { destination?: string; sensitivity?: string }
  returnMetadata?: { source?: string; sensitivity?: string }
  outcome?: 'benign' | 'consequential' | 'irreversible'
  requiresReview?: boolean
}

export interface McpTrustEvidenceReference {
  type: string
  digest: string
  canonicalization: string
  schema?: string
  ref?: string
}

export interface McpTrustAnnotations {
  sensitive?: boolean
  untrusted?: boolean
  evidenceRef?: McpTrustEvidenceReference
}
