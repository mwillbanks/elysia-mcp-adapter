export function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
}
