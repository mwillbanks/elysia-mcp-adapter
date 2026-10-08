import {
  type JSONRPCMessage,
  parseJSONRPCMessage,
  type Transport,
  type TransportSendOptions
} from '@modelcontextprotocol/client'
/**
 * MCP Apps v2 transport with parent-window validation and first-valid-origin
 * pinning. Opaque iframe origins still require `*` when sending.
 */
export class OriginBoundParentTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  constructor(
    private readonly hostWindow: Pick<
      Window,
      'parent' | 'addEventListener' | 'removeEventListener'
    > = window
  ) {}

  private hostOrigin?: string
  private started = false

  private readonly receive = (event: MessageEvent): void => {
    if (!this.acceptsSender(event)) return
    this.receiveHostMessage(event)
  }

  private acceptsSender(event: MessageEvent): boolean {
    return (
      event.source === this.hostWindow.parent &&
      (this.hostOrigin === undefined || event.origin === this.hostOrigin)
    )
  }

  private receiveHostMessage(event: MessageEvent): void {
    try {
      const message = parseJSONRPCMessage(event.data)
      this.hostOrigin ??= event.origin
      this.onmessage?.(message)
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP Apps transport is already started')
    if (this.hostWindow.parent === this.hostWindow)
      throw new Error('MCP App must be embedded by a host')
    this.started = true
    this.hostWindow.addEventListener('message', this.receive)
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.started) throw new Error('MCP Apps transport is not started')
    const targetOrigin = this.hostOrigin && this.hostOrigin !== 'null' ? this.hostOrigin : '*'
    this.hostWindow.parent.postMessage(message, targetOrigin)
  }

  async close(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.hostWindow.removeEventListener('message', this.receive)
    this.onclose?.()
  }
}
