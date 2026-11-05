import { MCP_SPECIFICATION_GOVERNANCE_SOURCES } from '../governance.js'
import {
  DPOP_PROOF_MAX_AGE_SECONDS,
  isDpopProofMaxAge,
  type McpDpopReplayAcceptor
} from './dpop.js'

export const MCP_DPOP_DRAFT_REVISION = MCP_SPECIFICATION_GOVERNANCE_SOURCES.dpop.source.revision

interface McpDpopSettings {
  /** The draft alias follows the currently supported revision. */
  version?: 'draft' | typeof MCP_DPOP_DRAFT_REVISION
  /** Require a DPoP-bound access token for every protected request. */
  required?: boolean
  /** Maximum proof age and future skew, in seconds. Defaults to 300. */
  maxAgeSeconds?: number
}

type McpDpopReplayPolicy =
  | { stateless: true; acceptReplay?: never }
  | { stateless?: never; acceptReplay: McpDpopReplayAcceptor }

export type McpDpopOptions = McpDpopSettings & McpDpopReplayPolicy

export type NormalizedMcpDpopOptions = Readonly<
  Required<Omit<McpDpopSettings, 'version'>> & {
    version: typeof MCP_DPOP_DRAFT_REVISION
  } & McpDpopReplayPolicy
>

const REPLAY_POLICY_GUIDANCE =
  'Auth dpop requires exactly one replay policy. Set acceptReplay to an atomic replay callback or set stateless: true to accept the freshness-window replay risk.'

function normalizeReplayPolicy(
  stateless: McpDpopOptions['stateless'],
  acceptReplay: McpDpopOptions['acceptReplay']
): McpDpopReplayPolicy {
  if (stateless === true && acceptReplay === undefined) return { stateless: true }
  if (stateless === undefined && typeof acceptReplay === 'function') return { acceptReplay }
  throw new TypeError(REPLAY_POLICY_GUIDANCE)
}

function resolveDpopRevision(version: NonNullable<McpDpopOptions['version']>) {
  if (version === 'draft' || version === MCP_DPOP_DRAFT_REVISION) return MCP_DPOP_DRAFT_REVISION
  throw new RangeError(
    'Unsupported DPoP revision. Use "draft" or "' +
      MCP_DPOP_DRAFT_REVISION +
      '" and review the current DPoP wire contract.'
  )
}

export function normalizeDpopOptions(
  selection: McpDpopOptions | undefined
): NormalizedMcpDpopOptions | undefined {
  if (selection === undefined) return undefined
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new TypeError(REPLAY_POLICY_GUIDANCE)
  }
  const {
    version = 'draft',
    required = false,
    maxAgeSeconds = DPOP_PROOF_MAX_AGE_SECONDS,
    stateless,
    acceptReplay
  } = selection

  if (typeof required !== 'boolean') throw new TypeError('Auth dpop.required must be a boolean')
  if (!isDpopProofMaxAge(maxAgeSeconds)) {
    throw new RangeError('Auth dpop.maxAgeSeconds must be greater than zero and at most 300')
  }
  return Object.freeze({
    version: resolveDpopRevision(version),
    required,
    maxAgeSeconds,
    ...normalizeReplayPolicy(stateless, acceptReplay)
  })
}
