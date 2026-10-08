import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { McpEventWebhookOptions, McpWebhookAddress, McpWebhookLastError } from './types.js'

const IPV4_SPECIAL: ReadonlyArray<readonly [string, boolean]> = [
  ['0.0.0.0/8', false],
  ['0.0.0.0/32', false],
  ['10.0.0.0/8', false],
  ['100.64.0.0/10', false],
  ['127.0.0.0/8', false],
  ['169.254.0.0/16', false],
  ['172.16.0.0/12', false],
  ['192.0.0.0/24', false],
  ['192.0.0.0/29', false],
  ['192.0.0.8/32', false],
  ['192.0.0.9/32', true],
  ['192.0.0.10/32', true],
  ['192.0.0.170/32', false],
  ['192.0.0.171/32', false],
  ['192.0.2.0/24', false],
  ['192.31.196.0/24', true],
  ['192.52.193.0/24', true],
  ['192.88.99.0/24', false],
  ['192.88.99.2/32', false],
  ['192.168.0.0/16', false],
  ['192.175.48.0/24', true],
  ['198.18.0.0/15', false],
  ['198.51.100.0/24', false],
  ['203.0.113.0/24', false],
  ['224.0.0.0/4', false],
  ['240.0.0.0/4', false],
  ['255.255.255.255/32', false]
]

const IPV6_SPECIAL: ReadonlyArray<readonly [string, boolean]> = [
  ['::1/128', false],
  ['::/128', false],
  ['::ffff:0:0/96', false],
  ['64:ff9b::/96', true],
  ['64:ff9b:1::/48', false],
  ['100::/64', false],
  ['100:0:0:1::/64', false],
  ['2001::/23', false],
  ['2001::/32', false],
  ['2001:1::1/128', true],
  ['2001:1::2/128', true],
  ['2001:1::3/128', true],
  ['2001:2::/48', false],
  ['2001:3::/32', true],
  ['2001:4:112::/48', true],
  ['2001:10::/28', false],
  ['2001:20::/28', true],
  ['2001:30::/28', true],
  ['2001:db8::/32', false],
  ['2002::/16', false],
  ['2620:4f:8000::/48', true],
  ['3fff::/20', false],
  ['5f00::/16', false],
  ['fc00::/7', false],
  ['fe80::/10', false],
  ['ff00::/8', false]
]

export interface McpWebhookHttpResponse {
  status: number
  body: Uint8Array
}

export class McpWebhookNetworkError extends Error {
  constructor(readonly reason: McpWebhookLastError) {
    super('Webhook endpoint request failed')
  }
}

export function parseWebhookUrl(value: string): URL {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new TypeError('Webhook callback URL is invalid')
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  )
    throw new TypeError('Webhook callback URL must be HTTPS without credentials or a fragment')
  return endpoint
}

export async function resolveWebhookEndpoint(
  endpoint: URL,
  options: Pick<McpEventWebhookOptions, 'allowPrivateAddresses' | 'resolveAddresses'>
): Promise<readonly McpWebhookAddress[]> {
  const hostname = stripBrackets(endpoint.hostname)
  const family = isIP(hostname)
  const addresses = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : await (options.resolveAddresses
        ? options.resolveAddresses(hostname)
        : lookup(hostname, { all: true, verbatim: true }).then((values) =>
            values.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
          ))
  if (addresses.length === 0) throw new McpWebhookNetworkError('connection_refused')
  for (const address of addresses) {
    if ((address.family !== 4 && address.family !== 6) || isIP(address.address) !== address.family)
      throw new McpWebhookNetworkError('connection_refused')
    if (!options.allowPrivateAddresses && !isGloballyRoutableAddress(address.address))
      throw new McpWebhookNetworkError('connection_refused')
  }
  return addresses.map(({ address, family: addressFamily }) => ({
    address,
    family: addressFamily
  }))
}

export async function postWebhook(
  endpoint: URL,
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
  options: Pick<
    McpEventWebhookOptions,
    'allowPrivateAddresses' | 'resolveAddresses' | 'requestTimeoutMs' | 'maxResponseBytes'
  >,
  signal?: AbortSignal
): Promise<McpWebhookHttpResponse> {
  const controller = new AbortController()
  const relay = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(
    () => controller.abort('Webhook request timeout'),
    options.requestTimeoutMs
  )
  try {
    if (controller.signal.aborted) throw new McpWebhookNetworkError('timeout')
    const addresses = await Promise.race([
      resolveWebhookEndpoint(endpoint, options),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new McpWebhookNetworkError('timeout')),
          { once: true }
        )
      )
    ])
    const selected = addresses[0] as McpWebhookAddress
    return await new Promise<McpWebhookHttpResponse>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        callback()
      }
      const request = httpsRequest(
        {
          protocol: 'https:',
          hostname: selected.address,
          port: endpoint.port ? Number(endpoint.port) : 443,
          method: 'POST',
          path: `${endpoint.pathname}${endpoint.search}`,
          headers: { ...headers, host: endpoint.host, 'content-length': String(body.byteLength) },
          agent: false,
          rejectUnauthorized: true,
          signal: controller.signal,
          ...(isIP(stripBrackets(endpoint.hostname)) === 0
            ? { servername: stripBrackets(endpoint.hostname) }
            : {})
        },
        (response) => {
          const chunks: Uint8Array[] = []
          let length = 0
          response.on('data', (chunk: Uint8Array) => {
            length += chunk.byteLength
            if (length > (options.maxResponseBytes ?? 64 * 1024)) {
              finish(() => reject(new McpWebhookNetworkError('http_5xx')))
              request.destroy()
              return
            }
            chunks.push(chunk)
          })
          response.on('aborted', () =>
            finish(() => reject(new McpWebhookNetworkError('connection_refused')))
          )
          response.on('error', (error: NodeJS.ErrnoException) =>
            finish(() => reject(classifyNetworkError(error, controller.signal)))
          )
          response.on('end', () =>
            finish(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
          )
          response.on('close', () => {
            if (!response.complete)
              finish(() => reject(new McpWebhookNetworkError('connection_refused')))
          })
        }
      )
      request.on('error', (error: NodeJS.ErrnoException) =>
        finish(() => reject(classifyNetworkError(error, controller.signal)))
      )
      request.end(body)
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
}

export function isGloballyRoutableAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const matched = longestPrefixMatch(address, IPV4_SPECIAL, 32)
    if (matched !== undefined) return matched
    const first = Number(address.split('.')[0])
    return first >= 1 && first <= 223
  }
  if (family !== 6) return false
  const value = ipv6ToBigInt(address)
  const mapped = cidrContains(value, ipv6ToBigInt('::ffff:0:0'), 96, 128)
  if (mapped) return false
  const nat64 = cidrContains(value, ipv6ToBigInt('64:ff9b::'), 96, 128)
  if (nat64) return isGloballyRoutableAddress(bigIntToIpv4(Number(value & 0xffffffffn)))
  const matched = longestPrefixMatch(address, IPV6_SPECIAL, 128)
  if (matched !== undefined) return matched
  return cidrContains(value, ipv6ToBigInt('2000::'), 3, 128)
}

function longestPrefixMatch(
  address: string,
  entries: ReadonlyArray<readonly [string, boolean]>,
  bits: 32 | 128
): boolean | undefined {
  const value = bits === 32 ? BigInt(ipv4ToNumber(address)) : ipv6ToBigInt(address)
  let selected: { prefix: number; reachable: boolean } | undefined
  for (const [cidr, reachable] of entries) {
    const [base, prefixText] = cidr.split('/') as [string, string]
    const prefix = Number(prefixText)
    const network = bits === 32 ? BigInt(ipv4ToNumber(base)) : ipv6ToBigInt(base)
    if (cidrContains(value, network, prefix, bits) && (!selected || prefix > selected.prefix))
      selected = { prefix, reachable }
  }
  return selected?.reachable
}

function cidrContains(value: bigint, network: bigint, prefix: number, bits: number): boolean {
  if (prefix === 0) return true
  const shift = BigInt(bits - prefix)
  return value >> shift === network >> shift
}

function ipv4ToNumber(value: string): number {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    throw new TypeError('Invalid IPv4 address')
  return (
    (((parts[0] as number) * 256 + (parts[1] as number)) * 256 + (parts[2] as number)) * 256 +
    (parts[3] as number)
  )
}

function ipv6ToBigInt(input: string): bigint {
  let value = stripBrackets(input).toLowerCase()
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    const ipv4 = ipv4ToNumber(value.slice(lastColon + 1))
    value = `${value.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
  }
  const sides = value.split('::')
  if (sides.length > 2) throw new TypeError('Invalid IPv6 address')
  const left = sides[0] ? sides[0].split(':') : []
  const right = sides[1] ? sides[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((sides.length === 1 && missing !== 0) || missing < 0)
    throw new TypeError('Invalid IPv6 address')
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8) throw new TypeError('Invalid IPv6 address')
  return groups.reduce((result, group) => {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) throw new TypeError('Invalid IPv6 address')
    return (result << 16n) | BigInt(Number.parseInt(group, 16))
  }, 0n)
}

function bigIntToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

function stripBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function classifyNetworkError(
  error: NodeJS.ErrnoException,
  signal: AbortSignal
): McpWebhookNetworkError {
  if (signal.aborted || error.name === 'AbortError') return new McpWebhookNetworkError('timeout')
  if (String(error.code ?? '').startsWith('ERR_TLS') || /certificate|tls/i.test(error.message))
    return new McpWebhookNetworkError('tls_error')
  return new McpWebhookNetworkError('connection_refused')
}
