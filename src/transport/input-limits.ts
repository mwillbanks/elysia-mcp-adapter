export function exceedsInputElementLimit(input: unknown, limit: number | undefined): boolean {
  if (limit === undefined) return false
  return countInputElements(input, limit) > limit
}

function countInputElements(input: unknown, limit: number): number {
  let count = 0
  const pending = [input]
  while (pending.length > 0) {
    const value = pending.pop()
    const values = nestedValues(value)
    if (!values) continue
    count += values.length
    if (count > limit) return count
    for (const child of values) pending.push(child)
  }
  return count
}

function nestedValues(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (value === null || typeof value !== 'object') return undefined
  return Object.values(value)
}
