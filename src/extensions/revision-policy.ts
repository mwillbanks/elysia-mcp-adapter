interface DraftRevisionPolicy<T extends string> {
  current: T | null
  superseded?: readonly string[]
  migration: string
}

/** Choose the only served draft revision or reject configuration for retired behavior. */
export function resolveGovernedDraftRevision<T extends string>(
  label: string,
  requested: string | undefined,
  policy: DraftRevisionPolicy<T>
): T {
  const { current, superseded, migration } = policy
  if (current === null) {
    throw new TypeError(`${label} support was removed. ${migration}`)
  }
  if (requested === undefined || requested === 'current' || requested === current) return current
  if (superseded?.includes(requested)) {
    throw new TypeError(`${label} revision "${requested}" was superseded. ${migration}`)
  }
  throw new TypeError(`Unsupported ${label} revision "${requested}". ${migration}`)
}
