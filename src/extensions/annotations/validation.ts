import { isRecord } from '../../internal.js'
import {
  MCP_ACTION_METADATA_ID,
  MCP_TRUST_ANNOTATIONS_ID,
  type McpActionMetadata,
  type McpTrustAnnotations
} from './types.js'

const MAX_EVIDENCE_FIELD_BYTES = 4096

export function assertActionMetadata(value: unknown): asserts value is McpActionMetadata {
  if (!isRecord(value)) throw new TypeError('Action metadata must be an object')
  for (const key of Object.keys(value)) {
    if (!['inputMetadata', 'returnMetadata', 'outcome', 'requiresReview'].includes(key)) {
      throw new TypeError(`Unknown action metadata field: ${key}`)
    }
  }
  assertOpenMetadata(value.inputMetadata, ['destination', 'sensitivity'], 'inputMetadata')
  assertOpenMetadata(value.returnMetadata, ['source', 'sensitivity'], 'returnMetadata')
  if (
    value.outcome !== undefined &&
    !['benign', 'consequential', 'irreversible'].includes(String(value.outcome))
  ) {
    throw new TypeError('Action metadata outcome is invalid')
  }
  if (value.requiresReview !== undefined && typeof value.requiresReview !== 'boolean') {
    throw new TypeError('Action metadata requiresReview must be boolean')
  }
}

export function assertTrustAnnotations(value: unknown): asserts value is McpTrustAnnotations {
  if (!isRecord(value)) throw new TypeError('Trust annotations must be an object')
  for (const key of ['sensitive', 'untrusted'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new TypeError(`Trust annotation ${key} must be boolean`)
    }
  }
  if (value.evidenceRef !== undefined) {
    if (!isRecord(value.evidenceRef)) throw new TypeError('Trust evidenceRef must be an object')
    for (const key of ['type', 'digest', 'canonicalization'] as const) {
      assertBoundedString(value.evidenceRef[key], `Trust evidenceRef ${key}`)
    }
    for (const key of ['schema', 'ref'] as const) {
      if (value.evidenceRef[key] !== undefined) {
        assertBoundedString(value.evidenceRef[key], `Trust evidenceRef ${key}`)
      }
    }
  }
}

export function assertToolAnnotationExtensions(annotations: unknown): void {
  if (!isRecord(annotations)) return
  if (annotations[MCP_ACTION_METADATA_ID] !== undefined) {
    assertActionMetadata(annotations[MCP_ACTION_METADATA_ID])
  }
}

export function assertTrustResultMetadata(meta: unknown): void {
  if (!isRecord(meta) || meta[MCP_TRUST_ANNOTATIONS_ID] === undefined) return
  assertTrustAnnotations(meta[MCP_TRUST_ANNOTATIONS_ID])
}

function assertOpenMetadata(value: unknown, keys: string[], label: string): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new TypeError(`Action metadata ${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`Unknown action metadata ${label} field: ${key}`)
    assertBoundedString(value[key], `Action metadata ${label}.${key}`)
  }
}

function assertBoundedString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`)
  if (new TextEncoder().encode(value).byteLength > MAX_EVIDENCE_FIELD_BYTES) {
    throw new TypeError(`${label} exceeds ${MAX_EVIDENCE_FIELD_BYTES} bytes`)
  }
}
