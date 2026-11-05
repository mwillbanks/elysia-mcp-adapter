import { isRecord } from '../../internal.js'
import { MCP_SERVER_CARD_DRAFT_REVISION, type McpServerCardRevision } from './types.js'

const EXTENSION_ID =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)*\/[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/iu
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']

export function assertRemoteExtensions(
  remotes: readonly unknown[] | undefined,
  revision: McpServerCardRevision
): void {
  for (const remote of remotes ?? []) {
    if (!isRecord(remote) || remote.extensions === undefined) continue
    if (revision !== MCP_SERVER_CARD_DRAFT_REVISION) {
      throw new TypeError('Server card remote extensions require the explicit draft revision')
    }
    assertExtensionMap(remote.extensions)
  }
}

function assertExtensionMap(value: unknown): void {
  if (!isPlainObject(value)) throw new TypeError('Server card remote extensions must be an object')
  for (const [id, entry] of Object.entries(value)) {
    if (!EXTENSION_ID.test(id))
      throw new TypeError('Server card extension identifiers require a prefix')
    if (!isPlainObject(entry))
      throw new TypeError('Server card extension information must be an object')
    assertJsonValue(entry, new Set())
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function assertJsonValue(value: unknown, parents: Set<object>): void {
  if (isPlainObject(value)) {
    assertPublicKeyMaterial(value)
    assertJsonChildren(value, Object.values(value), parents)
  } else if (Array.isArray(value)) {
    assertJsonChildren(value, value, parents)
  } else if (typeof value !== 'string' && typeof value !== 'boolean' && !Number.isInteger(value)) {
    throw new TypeError('Server card extension information must match the pinned JSON value schema')
  }
}

function assertJsonChildren(
  value: object,
  children: readonly unknown[],
  parents: Set<object>
): void {
  if (parents.has(value)) throw new TypeError('Server card extension information must be acyclic')
  parents.add(value)
  for (const child of children) assertJsonValue(child, parents)
  parents.delete(value)
}

function assertPublicKeyMaterial(value: Record<string, unknown>): void {
  if (value.kty === 'oct' || PRIVATE_JWK_MEMBERS.some((key) => Object.hasOwn(value, key))) {
    throw new TypeError('Server card extension information must not embed private key material')
  }
}
