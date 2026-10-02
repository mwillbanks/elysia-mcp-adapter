import { createHmac, timingSafeEqual } from 'node:crypto'

export type WebhookVerification =
  | { accepted: true; duplicate: boolean }
  | { accepted: false; duplicate: false }

export class StandardWebhookReceiver {
  readonly #seen = new Map<string, number>()
  readonly #maxEntries: number
  readonly #dedupTtlMs: number
  readonly #timestampToleranceSeconds: number

  constructor(
    options: { maxEntries?: number; dedupTtlMs?: number; timestampToleranceSeconds?: number } = {}
  ) {
    this.#maxEntries = options.maxEntries ?? 1_000
    this.#dedupTtlMs = options.dedupTtlMs ?? 5 * 60_000
    this.#timestampToleranceSeconds = options.timestampToleranceSeconds ?? 300
  }

  verify(
    body: Uint8Array,
    headers: Headers,
    secrets: readonly string[],
    now = Date.now()
  ): WebhookVerification {
    const id = headers.get('webhook-id')
    const timestamp = headers.get('webhook-timestamp')
    const signatureHeader = headers.get('webhook-signature')
    if (!id || !timestamp || !signatureHeader || !/^(0|[1-9]\d*)$/u.test(timestamp))
      return { accepted: false, duplicate: false }
    const timestampSeconds = Number(timestamp)
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(now / 1000 - timestampSeconds) > this.#timestampToleranceSeconds
    )
      return { accepted: false, duplicate: false }

    const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body])
    const candidates = signatureHeader.split(' ').filter(Boolean)
    const valid = secrets.some((secret) => {
      const expected = Buffer.from(
        `v1,${createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
          .update(signed)
          .digest('base64')}`
      )
      return candidates.some((candidate) => {
        const received = Buffer.from(candidate)
        return received.byteLength === expected.byteLength && timingSafeEqual(received, expected)
      })
    })
    if (!valid) return { accepted: false, duplicate: false }

    this.#prune(now)
    const duplicate = (this.#seen.get(id) ?? 0) > now
    if (!duplicate) {
      this.#seen.delete(id)
      while (this.#seen.size >= this.#maxEntries) {
        const oldest = this.#seen.keys().next().value
        if (oldest === undefined) break
        this.#seen.delete(oldest)
      }
      this.#seen.set(id, now + this.#dedupTtlMs)
    }
    return { accepted: true, duplicate }
  }

  #prune(now: number) {
    for (const [id, expiresAt] of this.#seen) if (expiresAt <= now) this.#seen.delete(id)
  }
}

export function challengeResponse(body: Uint8Array) {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as {
    type?: string
    challenge?: string
  }
  return parsed.type === 'verification' && typeof parsed.challenge === 'string'
    ? { challenge: parsed.challenge }
    : null
}
