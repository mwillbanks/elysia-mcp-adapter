import type {
  McpAuthorizationOptions,
  McpCachePolicy,
  McpInvocationContext,
  McpPaginationOptions
} from '../../types.js'

export const MCP_SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills' as const
export const MCP_SKILLS_VERSION = '167da6c0d42c247a8f8470228a10ca711e3f6c45' as const

export type McpSkillBytes = string | Uint8Array

export interface McpSkillResourceInput {
  content: McpSkillBytes
  mimeType?: string
}

export type McpSkillResourceValue = McpSkillBytes | McpSkillResourceInput

export interface McpSkillRegistrationOptions {
  /** Supporting files keyed by paths relative to the skill directory. */
  resources?: Readonly<Record<string, McpSkillResourceValue>> | 'dynamic'
  /** Explicit directory resources, keyed by relative path. Empty directories are supported. */
  directories?: readonly string[]
  /** Include this skill in skills/list. Direct skills/get remains available when false. */
  listed?: boolean
  authorization?: McpAuthorizationOptions
  /** Permit binary MIME types and non-UTF-8 supporting resources. */
  allowBinary?: boolean
  /** Reads explicitly declared dynamic resources. It never receives a filesystem path. */
  readResource?: McpSkillDynamicResourceReader
  /** Lists generated direct children. Registered SKILL.md and directories are added by the adapter. */
  readDirectory?: McpSkillDynamicDirectoryReader
}

export interface McpSkillResource {
  uri: string
  digest: string
  size: number
}

export interface McpSkill {
  uri: string
  frontmatter: { name: string; description: string; [key: string]: unknown }
  resources: McpSkillResource[] | 'dynamic'
}

export interface McpSkillSource {
  uri: string
  skill: McpSkillBytes
  resources?: Readonly<Record<string, McpSkillResourceValue>> | 'dynamic'
  directories?: readonly string[]
  listed?: boolean
  authorization?: McpAuthorizationOptions
  allowBinary?: boolean
}

export interface McpSkillProviderListRequest {
  offset: number
  limit?: number
}

export interface McpSkillProviderPage {
  skills: readonly McpSkillSource[]
  hasMore?: boolean
}

export interface McpSkillDirectoryEntry {
  uri: string
  name: string
  mimeType?: string
  size?: number
}

export interface McpSkillDirectoryPage {
  resources: readonly McpSkillDirectoryEntry[]
  hasMore?: boolean
}

export interface McpSkillProvider {
  list(
    request: McpSkillProviderListRequest,
    context: McpInvocationContext
  ): McpSkillProviderPage | Promise<McpSkillProviderPage>
  get(
    uri: string,
    context: McpInvocationContext
  ): McpSkillSource | null | Promise<McpSkillSource | null>
  read(
    uri: string,
    context: McpInvocationContext
  ): McpSkillResourceValue | null | Promise<McpSkillResourceValue | null>
  readDirectory?(
    uri: string,
    request: McpSkillProviderListRequest,
    context: McpInvocationContext
  ): McpSkillDirectoryPage | null | Promise<McpSkillDirectoryPage | null>
}

export type McpSkillDynamicResourceReader = (
  uri: string,
  context: McpInvocationContext
) => McpSkillResourceValue | null | Promise<McpSkillResourceValue | null>

export type McpSkillDynamicDirectoryReader = (
  uri: string,
  request: McpSkillProviderListRequest,
  context: McpInvocationContext
) => McpSkillDirectoryPage | null | Promise<McpSkillDirectoryPage | null>

export interface McpSkillsOptions {
  /** Current stable extension pin. */
  version?: 'current' | typeof MCP_SKILLS_VERSION
  directoryRead?: boolean
  provider?: McpSkillProvider
  authorization?: McpAuthorizationOptions
  pagination?: McpPaginationOptions
  cache?: Partial<McpCachePolicy>
}

export interface McpSkillDefinition {
  source: 'explicit'
  uri: string
  rootUri: string
  entry: McpSkill
  files: ReadonlyMap<string, McpSkillStoredResource>
  directories: ReadonlySet<string>
  listed: boolean
  authorization?: McpAuthorizationOptions
  allowBinary: boolean
  readResource?: McpSkillDynamicResourceReader
  readDirectory?: McpSkillDynamicDirectoryReader
}

export interface McpSkillStoredResource {
  uri: string
  name: string
  bytes: Uint8Array
  mimeType: string
  binary: boolean
}

export interface ExplicitSkillRegistration {
  uri: string
  skill: McpSkillBytes
  options: McpSkillRegistrationOptions
}
