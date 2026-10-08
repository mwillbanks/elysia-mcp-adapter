export type Source = {
  repository?: string
  revision?: string
  url?: string
  path: string
  sha256: string
  packageName?: string
  packageVersion?: string
  trackHead?: boolean
}

export type ManifestRecord = {
  source?: Source
  availability?: string
  identifier?: string
  reason?: string
}

export function collectManifestRecords(manifest: unknown): ManifestRecord[] {
  const records: ManifestRecord[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if ('source' in value || 'availability' in value) records.push(value as ManifestRecord)
    for (const child of Object.values(value)) visit(child)
  }
  visit(manifest)
  return records
}

export function uniqueSources(records: ManifestRecord[]): Source[] {
  return Array.from(
    new Map(
      records
        .filter((record): record is ManifestRecord & { source: Source } => Boolean(record.source))
        .map((record) => [sourceKey(record.source), record.source])
    ).values()
  )
}

export function groupSourcesByRepository(records: ManifestRecord[]): Map<string, Source[]> {
  const grouped = new Map<string, Source[]>()
  for (const source of uniqueSources(records)) {
    if (!source.repository || !source.revision) continue
    const group = grouped.get(source.repository) ?? []
    group.push(source)
    grouped.set(source.repository, group)
  }
  return grouped
}

export function uniquePackageSources(records: ManifestRecord[]): Source[] {
  return Array.from(
    new Map(
      uniqueSources(records)
        .filter((source) => source.packageName && source.packageVersion)
        .map((source) => [`${source.packageName}\0${source.packageVersion}`, source])
    ).values()
  )
}

function sourceKey(source: Source): string {
  return `${source.url ?? source.repository}\0${source.revision ?? ''}\0${source.path}`
}

export function pinnedGithubUrl(source: Source): string {
  if (!source.repository || !source.revision)
    throw new TypeError(`Pinned source ${source.path} has no URL or Git revision`)
  const repository = new URL(source.repository).pathname.replace(/^\//u, '').replace(/\.git$/u, '')
  return `https://raw.githubusercontent.com/${repository}/${source.revision}/${source.path}`
}
