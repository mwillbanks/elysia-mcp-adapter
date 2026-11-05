import { isRecord } from '../../internal.js'
import { mcpInput, type McpInvocationInput } from '../../transport/input.js'
import { McpProtocolError } from '../../transport/protocol-error.js'
import type { McpInputRequiredResult } from '../../types.js'
import { MCP_SPECIFICATION_GOVERNANCE_SOURCES } from '../governance.js'
import { resolveGovernedDraftRevision } from '../revision-policy.js'
import type { GetTaskResult } from '../tasks/types.js'
import type { McpAuthPrincipal } from './types.js'

export const MCP_STRUCTURED_AUTHORIZATION_DENIALS_REVISION =
  MCP_SPECIFICATION_GOVERNANCE_SOURCES.structuredAuthorizationDenials.source.revision
const AUTHORIZATION_METADATA = 'io.modelcontextprotocol/authorization'

type DenialClassification = 'unavailable' | 'undisclosed'
type DenialHint =
  | { type: 'url' | 'task' }
  | {
      type: 'authorization_remediation'
      authorization_details: readonly McpAuthorizationDetail[]
      authorization_reference?: string
    }

export interface McpAuthorizationDetail extends Readonly<Record<string, unknown>> {
  type: string
}

export type McpAuthorizationDenialMetadata = {
  readonly [AUTHORIZATION_METADATA]: {
    readonly reason: 'insufficient_authorization'
    readonly remediation: DenialClassification | 'available'
    readonly authorizationContextId?: string
    readonly remediationHints?: readonly DenialHint[]
  }
}

export interface McpStructuredAuthorizationContext {
  tool: string
  arguments: unknown
  principal: Readonly<McpAuthPrincipal>
  signal: AbortSignal
  /** Server state from a verified signed MRTR continuation, when configured. */
  continuationState?: string
}

export interface McpAuthorizationApprovalTaskContext extends McpStructuredAuthorizationContext {
  principalKey: string
  /** Store this value as the pending task's _meta until it reaches a terminal state. */
  metadata: McpAuthorizationDenialMetadata
}

interface DeniedOperation {
  /** An optional server-generated audit handle. */
  authorizationContextId?: string
}

export type McpStructuredAuthorizationDecision =
  | { kind: 'allow' }
  | (DeniedOperation & { kind: 'deny'; remediation: DenialClassification })
  | (DeniedOperation & {
      kind: 'url'
      url: string
      message: string
      inputKey: string
      continuationState?: string
    })
  | (DeniedOperation & {
      kind: 'credential'
      authorizationDetails: readonly McpAuthorizationDetail[]
    } & (
        | { singleUseCredential: true; authorizationReference?: never }
        | { singleUseCredential?: false; authorizationReference?: string }
      ))
  | (DeniedOperation & {
      kind: 'task'
      /** Start or reuse a durable principal-bound approval and return its task ID. */
      start(context: McpAuthorizationApprovalTaskContext): string | Promise<string>
    })

export interface McpStructuredAuthorizationDenialsOptions {
  version?: 'current' | typeof MCP_STRUCTURED_AUTHORIZATION_DENIALS_REVISION
  evaluate(
    context: McpStructuredAuthorizationContext
  ): McpStructuredAuthorizationDecision | Promise<McpStructuredAuthorizationDecision>
}

export interface NormalizedStructuredAuthorizationDenials extends McpStructuredAuthorizationDenialsOptions {
  version: typeof MCP_STRUCTURED_AUTHORIZATION_DENIALS_REVISION
}

export function normalizeStructuredAuthorizationDenials(
  options: McpStructuredAuthorizationDenialsOptions | undefined
): NormalizedStructuredAuthorizationDenials | undefined {
  if (options === undefined) return undefined
  if (!options || typeof options.evaluate !== 'function') {
    throw new TypeError('Structured authorization denials require an evaluate callback')
  }
  return {
    evaluate: options.evaluate.bind(options),
    version: resolveGovernedDraftRevision('Structured authorization denials', options.version, {
      current: MCP_STRUCTURED_AUTHORIZATION_DENIALS_REVISION,
      migration: 'Select the current SEP-2643 revision and review its wire contract.'
    })
  }
}

type TaskApprovalAccess = {
  principalKey: string
  get(taskId: string): Promise<GetTaskResult>
}

interface DenialRuntime {
  input: McpInvocationInput
  task?: TaskApprovalAccess
}

type AuthorizationDenialToolResult = {
  resultType: 'complete'
  isError: true
  content: [{ type: 'text'; text: string }]
  _meta: McpAuthorizationDenialMetadata
}

function denialMetadata(
  remediation: DenialClassification | 'available',
  authorizationContextId: string | undefined,
  hint?: DenialHint
): McpAuthorizationDenialMetadata {
  return {
    [AUTHORIZATION_METADATA]: {
      reason: 'insufficient_authorization',
      remediation,
      ...(authorizationContextId === undefined ? {} : { authorizationContextId }),
      ...(hint === undefined ? {} : { remediationHints: [hint] })
    }
  }
}

function invalidDecision(): never {
  throw new McpProtocolError(-32603, 'Structured authorization evaluation failed')
}

function opaqueIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(value)) {
    return invalidDecision()
  }
  return value
}

function optionalIdentifier(value: unknown): string | undefined {
  return value === undefined ? undefined : opaqueIdentifier(value)
}

function deniedResult(
  metadata: McpAuthorizationDenialMetadata,
  text: string
): AuthorizationDenialToolResult {
  return {
    resultType: 'complete',
    isError: true,
    content: [{ type: 'text', text }],
    _meta: metadata
  }
}

/** Build the nested result for a durable approval task whose operation was refused. */
export function createMcpAuthorizationDenialResult(
  remediation: DenialClassification,
  authorizationContextId?: string
): AuthorizationDenialToolResult {
  if (remediation !== 'unavailable' && remediation !== 'undisclosed') return invalidDecision()
  return deniedResult(
    denialMetadata(remediation, optionalIdentifier(authorizationContextId)),
    'The requested operation is not authorized.'
  )
}

function undisclosedDenial(id: string | undefined, text: string) {
  return deniedResult(denialMetadata('undisclosed', id), text)
}

function urlDenial(
  decision: Extract<McpStructuredAuthorizationDecision, { kind: 'url' }>,
  input: McpInvocationInput,
  id: string | undefined
): McpInputRequiredResult | AuthorizationDenialToolResult {
  const key = opaqueIdentifier(decision.inputKey)
  const request = approvalUrlRequest(decision)
  if (!input.supports(request)) {
    return undisclosedDenial(id, 'This operation requires approval through a URL.')
  }
  const answer = input.response(key, request)
  if (answer?.action === 'decline' || answer?.action === 'cancel') {
    return undisclosedDenial(id, 'The approval interaction was declined or canceled.')
  }
  return {
    ...input.require({ [key]: request }, { state: decision.continuationState }),
    _meta: denialMetadata('available', id, { type: 'url' })
  }
}

function approvalUrlRequest(
  decision: Extract<McpStructuredAuthorizationDecision, { kind: 'url' }>
) {
  const { url, message, continuationState } = decision
  const target = secureApprovalUrl(url)
  if (typeof message !== 'string' || !message.trim() || message.length > 4096)
    return invalidDecision()
  if (continuationState !== undefined && typeof continuationState !== 'string')
    return invalidDecision()
  return mcpInput.url({ url: target.href, message })
}

function secureApprovalUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 4096) return invalidDecision()
  const target = new URL(value)
  if (target.protocol !== 'https:' || target.username || target.password) return invalidDecision()
  return target
}

// Accept plain JSON only. Avoid serializing host objects with toJSON or accessors.
function copyJson(value: unknown, budget = { remaining: 4096 }, depth = 0): unknown {
  if (depth > 16 || --budget.remaining < 0) return invalidDecision()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return copyJsonContainer(value, budget, depth + 1)
}

function copyJsonContainer(value: unknown, budget: { remaining: number }, depth: number): unknown {
  if (Array.isArray(value)) {
    if (value.length > budget.remaining) return invalidDecision()
    return Array.from({ length: value.length }, (_, index) =>
      copyJson(readOwnValue(value, String(index)), budget, depth)
    )
  }
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return invalidDecision()
  }
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, copyJson(readOwnValue(value, key), budget, depth)])
  )
}

function readOwnValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) return invalidDecision()
  return descriptor.value
}

function credentialDenial(
  decision: Extract<McpStructuredAuthorizationDecision, { kind: 'credential' }>,
  id: string | undefined
): AuthorizationDenialToolResult {
  const { authorizationDetails, authorizationReference, singleUseCredential } = decision
  if (
    !Array.isArray(authorizationDetails) ||
    authorizationDetails.length === 0 ||
    (singleUseCredential !== undefined && typeof singleUseCredential !== 'boolean') ||
    (singleUseCredential && authorizationReference !== undefined)
  )
    return invalidDecision()
  const details = copyJson(authorizationDetails) as McpAuthorizationDetail[]
  if (
    details.some(
      (detail) => !isRecord(detail) || typeof detail.type !== 'string' || !detail.type.trim()
    )
  ) {
    return invalidDecision()
  }
  const reference = optionalIdentifier(authorizationReference)
  return deniedResult(
    denialMetadata('available', id, {
      type: 'authorization_remediation',
      authorization_details: details,
      ...(reference === undefined ? {} : { authorization_reference: reference })
    }),
    'A credential with additional authorization is required.'
  )
}

function isPendingTask(task: GetTaskResult): boolean {
  return task.status === 'working' || task.status === 'input_required'
}

/** Restrict the reserved provider metadata to the pending envelope generated by this adapter. */
export function sanitizeAuthorizationTaskResult(task: GetTaskResult): GetTaskResult {
  const meta = task._meta
  if (!isRecord(meta) || !Object.hasOwn(meta, AUTHORIZATION_METADATA)) return task

  const { [AUTHORIZATION_METADATA]: envelope, ...rest } = meta
  if (!isPendingTask(task)) return { ...task, _meta: rest }
  if (
    !isRecord(envelope) ||
    envelope.reason !== 'insufficient_authorization' ||
    envelope.remediation !== 'available' ||
    !Array.isArray(envelope.remediationHints) ||
    envelope.remediationHints.length !== 1 ||
    !isRecord(envelope.remediationHints[0]) ||
    envelope.remediationHints[0].type !== 'task'
  )
    return invalidDecision()
  const metadata = denialMetadata(
    'available',
    optionalIdentifier(envelope.authorizationContextId),
    {
      type: 'task'
    }
  )
  return { ...task, _meta: { ...rest, ...metadata } }
}

async function taskDenial(
  decision: Extract<McpStructuredAuthorizationDecision, { kind: 'task' }>,
  context: McpStructuredAuthorizationContext,
  task: TaskApprovalAccess | undefined,
  id: string | undefined
) {
  if (typeof decision.start !== 'function') return invalidDecision()
  if (!task) return undisclosedDenial(id, 'This operation requires out-of-band approval.')
  const metadata = denialMetadata('available', id, { type: 'task' })
  const taskId = opaqueIdentifier(
    await decision.start({
      ...context,
      principalKey: task.principalKey,
      metadata: structuredClone(metadata)
    })
  )
  const snapshot = sanitizeAuthorizationTaskResult(await task.get(taskId))
  const meta = snapshot._meta
  const envelope = isRecord(meta) ? meta[AUTHORIZATION_METADATA] : undefined
  if (
    snapshot.taskId !== taskId ||
    snapshot.status !== 'working' ||
    !isRecord(envelope) ||
    envelope.authorizationContextId !== id
  )
    return invalidDecision()
  const { status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs } = snapshot
  return {
    resultType: 'task' as const,
    taskId,
    status,
    createdAt,
    lastUpdatedAt,
    ttlMs,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    _meta: metadata
  }
}

export async function evaluateStructuredAuthorization(
  options: NormalizedStructuredAuthorizationDenials,
  context: McpStructuredAuthorizationContext,
  runtime: DenialRuntime
) {
  try {
    context.signal.throwIfAborted()
    const decision = await options.evaluate(structuredContext(context))
    context.signal.throwIfAborted()
    if (typeof decision !== 'object' || decision === null || !Object.hasOwn(decision, 'kind'))
      return invalidDecision()
    if (decision.kind === 'allow') return undefined
    const id = optionalIdentifier(decision.authorizationContextId)
    switch (decision.kind) {
      case 'deny':
        return createMcpAuthorizationDenialResult(decision.remediation, id)
      case 'url':
        return urlDenial(decision, runtime.input, id)
      case 'credential':
        return credentialDenial(decision, id)
      case 'task':
        return await taskDenial(decision, structuredContext(context), runtime.task, id)
      default:
        return invalidDecision()
    }
  } catch {
    // Host errors and malformed decisions may contain credentials or private policy data.
    return invalidDecision()
  }
}

function structuredContext(
  context: McpStructuredAuthorizationContext
): McpStructuredAuthorizationContext {
  const { tool, principal, signal, continuationState } = context
  const { tokenType, subject, issuer, audience, expiresAt, scopes, clientId, dpopJkt, claims } =
    principal
  return {
    tool,
    arguments: structuredClone(context.arguments),
    principal: structuredClone({
      tokenType,
      subject,
      issuer,
      audience,
      expiresAt,
      scopes,
      clientId,
      dpopJkt,
      claims
    }),
    signal,
    ...(continuationState === undefined ? {} : { continuationState })
  }
}
