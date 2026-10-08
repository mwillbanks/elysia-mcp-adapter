export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status = 400,
    readonly data?: unknown
  ) {
    super(message)
  }
}
