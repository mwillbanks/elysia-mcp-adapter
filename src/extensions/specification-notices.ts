import { Console } from 'node:console'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { isRecord } from '../internal.js'
import type { NormalizedMcpPluginOptions } from '../types.js'
import { MCP_ACTION_METADATA_ID, MCP_TRUST_ANNOTATIONS_ID } from './annotations/types.js'
import { MCP_SPECIFICATION_INVENTORY, MCP_SPECIFICATION_LIFECYCLE } from './governance.js'
import { MCP_EXTENSION_SUPPORT } from './manifest.js'

export type McpSpecificationNotice = Readonly<{
  code: 'MCP_SPECIFICATION_PRE_RELEASE' | 'MCP_SPECIFICATION_DEPRECATED'
  severity: 'info' | 'warn'
  featureId: string
  revision: string
  sourceUrl: string
  migration?: string
}>

export interface McpSpecificationNoticeOptions {
  local?: boolean
  openTelemetry?: boolean
  onNotice?: (notice: McpSpecificationNotice) => void | Promise<void>
}

// Keep application stdout clean and let Node's Console contain stream errors.
// The toolchain types omit the Node Console instance methods.
const specificationConsole = new Console({
  stdout: process.stderr,
  stderr: process.stderr,
  ignoreErrors: true
}) as unknown as Pick<typeof console, 'info' | 'warn'>

function writeLocalNotice(
  notice: McpSpecificationNotice,
  callback: McpSpecificationNoticeOptions['onNotice']
): void {
  try {
    if (callback) {
      void Promise.resolve(callback(notice)).catch(() => {})
    } else {
      specificationConsole[notice.severity](JSON.stringify(notice))
    }
  } catch {
    // Diagnostics must not disrupt request handling or other sinks.
  }
}

function writeTelemetryNotice(notice: McpSpecificationNotice): void {
  try {
    logs.getLogger('@mwillbanks/elysia-mcp-adapter').emit({
      severityNumber: notice.severity === 'warn' ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: notice.severity.toUpperCase(),
      body: notice.code,
      attributes: {
        'mcp.specification.code': notice.code,
        'mcp.specification.feature': notice.featureId,
        'mcp.specification.revision': notice.revision,
        'mcp.specification.source': notice.sourceUrl,
        ...(notice.migration && { 'mcp.specification.migration': notice.migration })
      }
    })
  } catch {
    // The host owns its Logs provider. A provider failure cannot change adapter behavior.
  }
}

type SpecificationFeature =
  keyof typeof MCP_SPECIFICATION_INVENTORY | keyof typeof MCP_SPECIFICATION_LIFECYCLE

const FEATURE_IDS: Partial<Record<SpecificationFeature, string>> = {
  tasks: MCP_EXTENSION_SUPPORT.tasks.identifier,
  tasksDraft: MCP_EXTENSION_SUPPORT.tasks.identifier,
  skills: MCP_EXTENSION_SUPPORT.skills.identifier,
  skillsHistorical: MCP_EXTENSION_SUPPORT.skills.identifier,
  authorizationDraft: MCP_EXTENSION_SUPPORT.auth.identifier,
  appsDraft: MCP_EXTENSION_SUPPORT.apps.identifier,
  serverCard: MCP_EXTENSION_SUPPORT.serverCard.identifier,
  serverCardExtensions: MCP_EXTENSION_SUPPORT.serverCard.identifier,
  interceptors: MCP_EXTENSION_SUPPORT.interceptors.identifier,
  events: MCP_EXTENSION_SUPPORT.events.identifier,
  actionMetadata: MCP_ACTION_METADATA_ID,
  trustAnnotations: MCP_TRUST_ANNOTATIONS_ID,
  language: 'io.modelcontextprotocol/acceptLanguage',
  dpop: 'io.modelcontextprotocol/dpop',
  structuredAuthorizationDenials: 'io.modelcontextprotocol/structured-authorization-denials'
}

export type SpecificationNoticeReporter = (feature: SpecificationFeature) => void

function specificationNotice(feature: SpecificationFeature): McpSpecificationNotice | undefined {
  if (Object.hasOwn(MCP_SPECIFICATION_LIFECYCLE, feature)) {
    const { featureId, revision, sourceUrl, migration } =
      MCP_SPECIFICATION_LIFECYCLE[feature as keyof typeof MCP_SPECIFICATION_LIFECYCLE]
    return {
      code: 'MCP_SPECIFICATION_DEPRECATED',
      severity: 'warn',
      featureId,
      revision,
      sourceUrl,
      migration
    }
  }

  const record = MCP_SPECIFICATION_INVENTORY[feature as keyof typeof MCP_SPECIFICATION_INVENTORY]
  if (record.disposition !== 'implemented' || record.stage === 'stable' || !('source' in record)) {
    return undefined
  }
  const { repository, revision, path } = record.source
  return {
    code: 'MCP_SPECIFICATION_PRE_RELEASE',
    severity: 'info',
    featureId: FEATURE_IDS[feature] ?? feature,
    revision,
    sourceUrl: `${repository}/blob/${revision}/${path}`
  }
}

export function createSpecificationNoticeReporter(
  options?: McpSpecificationNoticeOptions
): SpecificationNoticeReporter {
  const { local = true, openTelemetry = false, onNotice } = options ?? {}
  const emitted = new Set<string>()
  return (feature: SpecificationFeature): void => {
    if (!local && !openTelemetry) return
    const notice = specificationNotice(feature)
    if (!notice) return
    const key = JSON.stringify([notice.code, notice.featureId, notice.revision])
    if (emitted.has(key)) return
    emitted.add(key)

    if (local) writeLocalNotice(Object.freeze({ ...notice }), onNotice)
    if (openTelemetry) writeTelemetryNotice(notice)
  }
}

export function reportConfiguredSpecificationNotices(
  options: NormalizedMcpPluginOptions,
  report: SpecificationNoticeReporter
): void {
  const { core, extensions } = options
  const { tasks, skills, serverCard, events, interceptors, auth, variants, apps } = extensions
  const configured: [SpecificationFeature, unknown][] = [
    [tasks?.version === MCP_EXTENSION_SUPPORT.tasks.draft ? 'tasksDraft' : 'tasks', tasks],
    [
      skills?.version === MCP_EXTENSION_SUPPORT.skills.current ? 'skills' : 'skillsHistorical',
      skills
    ],
    [
      serverCard?.version === MCP_EXTENSION_SUPPORT.serverCard.draft
        ? 'serverCardExtensions'
        : 'serverCard',
      serverCard
    ],
    ['events', events],
    ['interceptors', interceptors],
    ['dpop', auth?.dpop],
    ['structuredAuthorizationDenials', auth?.structuredDenials],
    ['authorizationDraft', auth?.version === 'draft'],
    ['appsDraft', apps?.version === 'draft'],
    ['serverVariants', variants],
    ['language', core.language],
    ['logging', core.logging]
  ]
  for (const [feature, enabled] of configured) {
    if (enabled) report(feature)
  }
}

export function reportInputRequestNotices(
  report: SpecificationNoticeReporter | undefined,
  inputRequests: unknown
): void {
  if (!report || !isRecord(inputRequests)) return
  for (const request of Object.values(inputRequests)) {
    if (!isRecord(request)) continue
    if (request.method === 'roots/list') report('roots')
    if (request.method === 'sampling/createMessage') reportSamplingNotices(report, request.params)
  }
}

function reportSamplingNotices(report: SpecificationNoticeReporter, params: unknown): void {
  report('sampling')
  const context = isRecord(params) ? params.includeContext : undefined
  if (context === 'thisServer' || context === 'allServers') report('samplingIncludeContext')
}

export function reportToolAnnotationNotices(
  report: SpecificationNoticeReporter | undefined,
  method: string,
  result: Record<string, unknown>
): void {
  if (!report) return
  if (method === 'tools/call' && isRecord(result._meta)) {
    if (Object.hasOwn(result._meta, MCP_TRUST_ANNOTATIONS_ID)) report('trustAnnotations')
  }
  if (method !== 'tools/list' || !Array.isArray(result.tools)) return
  if (result.tools.some(hasActionMetadata)) report('actionMetadata')
}

function hasActionMetadata(tool: unknown): boolean {
  return (
    isRecord(tool) &&
    isRecord(tool.annotations) &&
    Object.hasOwn(tool.annotations, MCP_ACTION_METADATA_ID)
  )
}
