import { MCP_EXTENSION_LATEST_REVIEWED, MCP_EXTENSION_SUPPORT } from '../src/extensions/manifest.js'

type Source = {
  repository?: string
  revision?: string
  url?: string
  path: string
  sha256: string
  packageName?: string
  packageVersion?: string
  trackHead?: boolean
}

type ManifestRecord = {
  source?: Source
  availability?: string
  identifier?: string
  reason?: string
}

const token = process.env.GH_TOKEN
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'elysia-mcp-adapter-extension-watch',
  ...(token ? { authorization: `Bearer ${token}` } : {})
}
const drift: string[] = []
const observations: string[] = []
const compatibilityRecords = collectManifestRecords(MCP_EXTENSION_SUPPORT)
const records = collectManifestRecords(MCP_EXTENSION_LATEST_REVIEWED)
const packageManifestPaths = [
  'package.json',
  'website/package.json',
  'examples/tasks/package.json',
  'examples/auth/package.json',
  'examples/apps-vanilla/package.json',
  'examples/apps-react/package.json',
  'examples/core/package.json',
  'examples/skills/package.json',
  'examples/experimental/package.json',
  'examples/events/package.json'
] as const

for (const record of records) {
  if (record.availability === 'unavailable') {
    drift.push(
      `Authoritative source is unavailable for ${record.identifier ?? 'unnamed record'}: ${record.reason ?? 'no reason recorded'}`
    )
  }
}

// Every historical alias is integrity-checked, but only latest-reviewed records
// are compared with repository heads and package registries. Old aliases are
// intentionally immutable snapshots and must not produce perpetual head drift.
for (const source of uniqueSources([...compatibilityRecords, ...records]))
  await verifySource(source)
for (const [repository, sources] of groupSourcesByRepository(records)) {
  await compareRepositoryHead(repository, sources)
}
for (const source of uniquePackageSources(records)) await compareNpmPackage(source)
for (const dependency of await declaredRegistryDependencies(packageManifestPaths))
  await compareDeclaredPackage(dependency)
for (const [repository, version] of await declaredActions())
  await compareGithubRelease(repository, version)
await compareGithubRelease('oven-sh/bun', 'bun-v1.4.2')
await compareRedisRelease('8.10.2')

const report = [
  '## MCP extension upstream drift report',
  '',
  ...observations.map((item) => `- ${item}`),
  '',
  ...(drift.length > 0
    ? ['### Review required', '', ...drift.map((item) => `- ${item}`), '']
    : ['No upstream drift or pinned-source integrity failure was detected.', '']),
  'Review specifications, fixtures, schema hashes, compatibility, and documentation before changing any alias.'
].join('\n')

const output = process.env.GITHUB_OUTPUT
if (output) {
  await Bun.write(
    output,
    `drift=${drift.length > 0}\nreport<<MCP_DRIFT_EOF\n${report}\nMCP_DRIFT_EOF\n`
  )
} else {
  console.log(report)
}

// Every drift result is a hard failure. The report still explains the exact
// source or registry record that requires review before an alias changes.
if (drift.length > 0) process.exitCode = 1

async function compareRepositoryHead(repository: string, sources: Source[]): Promise<void> {
  const headSources = sources.filter((source) => source.trackHead !== false)
  if (headSources.length === 0) return
  const repositoryPath = new URL(repository).pathname.replace(/^\//u, '').replace(/\.git$/u, '')
  let metadata: Record<string, unknown>
  try {
    metadata = await githubJson(`https://api.github.com/repos/${repositoryPath}`)
  } catch {
    metadata = { default_branch: 'main' }
  }
  const branch = typeof metadata.default_branch === 'string' ? metadata.default_branch : 'main'
  let current: string
  try {
    current = await githubValue(
      `https://api.github.com/repos/${repositoryPath}/commits/${encodeURIComponent(branch)}`,
      (value) => value.sha
    )
  } catch {
    try {
      current = await gitRepositoryHead(repository, branch)
    } catch (error) {
      drift.push(`Repository head is unavailable (${errorMessage(error)}): \`${repository}\`.`)
      return
    }
  }
  observations.push(`${repositoryPath} ${branch}: \`${current}\``)
  for (const source of headSources) {
    if (current !== source.revision) {
      drift.push(
        `Upstream advanced beyond \`${source.path}\` (reviewed \`${source.revision}\`, head \`${current}\`).`
      )
    }
  }
}

async function gitRepositoryHead(repository: string, branch: string): Promise<string> {
  const process = Bun.spawn(['git', 'ls-remote', repository, `refs/heads/${branch}`], {
    stderr: 'pipe',
    stdout: 'pipe'
  })
  const output = (await new Response(process.stdout).text()).trim()
  const exitCode = await process.exited
  const sha = output.split(/\s+/u)[0]
  if (exitCode !== 0 || !/^[0-9a-f]{40}$/iu.test(sha ?? '')) {
    const error = await new Response(process.stderr).text()
    throw new Error(error.trim() || `git ls-remote exited with ${exitCode}`)
  }
  return sha
}

async function compareNpmPackage(source: Source): Promise<void> {
  if (!source.packageName || !source.packageVersion) return
  let response: Response
  try {
    response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(source.packageName)}/latest`,
      { headers: { accept: 'application/json', 'user-agent': headers['user-agent'] } }
    )
  } catch (error) {
    drift.push(
      `Package source is unavailable (${errorMessage(error)}): ${source.packageName} (reviewed ${source.packageVersion}).`
    )
    return
  }
  if (!response.ok) {
    drift.push(
      `Package source is unavailable (${response.status}): ${source.packageName} (reviewed ${source.packageVersion}).`
    )
    return
  }
  const current = ((await response.json()) as { version?: unknown }).version
  if (typeof current !== 'string') {
    drift.push(`Package source returned an invalid document: ${source.packageName}.`)
    return
  }
  observations.push(
    `${source.packageName}: \`${current}\` (reviewed: \`${source.packageVersion}\`)`
  )
  if (current !== source.packageVersion) {
    drift.push(
      `Package advanced beyond ${source.packageName} (reviewed \`${source.packageVersion}\`, latest \`${current}\`).`
    )
  }
}

interface DeclaredDependency {
  name: string
  version: string
  manifests: string[]
}

async function declaredRegistryDependencies(
  paths: readonly string[]
): Promise<DeclaredDependency[]> {
  const dependencies = new Map<string, DeclaredDependency>()
  for (const path of paths) {
    const manifest = (await Bun.file(path).json()) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies
    })) {
      if (/^(?:link:|workspace:|file:)/u.test(range)) continue
      const version = range.replace(/^[~^]/u, '')
      const key = `${name}\0${version}`
      const existing = dependencies.get(key)
      if (existing) existing.manifests.push(path)
      else dependencies.set(key, { name, version, manifests: [path] })
    }
  }
  return [...dependencies.values()]
}

async function compareDeclaredPackage(dependency: DeclaredDependency): Promise<void> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(dependency.name)}/latest`
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': headers['user-agent'] }
    })
    if (!response.ok) throw new Error(`registry returned ${response.status}`)
    const latest = ((await response.json()) as { version?: unknown }).version
    if (typeof latest !== 'string') throw new Error('registry omitted latest version')
    observations.push(`${dependency.name}: \`${latest}\``)
    if (latest !== dependency.version)
      drift.push(
        `Declared dependency ${dependency.name} is \`${dependency.version}\`, latest is \`${latest}\` (${dependency.manifests.join(', ')}).`
      )
  } catch (error) {
    drift.push(`Dependency registry is unavailable for ${dependency.name}: ${errorMessage(error)}.`)
  }
}

async function compareGithubRelease(repository: string, expected: string): Promise<void> {
  try {
    const latest = await githubValue(
      `https://api.github.com/repos/${repository}/releases/latest`,
      (value) => value.tag_name
    )
    observations.push(`${repository}: \`${latest}\``)
    if (latest !== expected)
      drift.push(`${repository} advanced beyond reviewed release \`${expected}\` to \`${latest}\`.`)
  } catch (error) {
    drift.push(`Release metadata is unavailable for ${repository}: ${errorMessage(error)}.`)
  }
}

async function declaredActions(): Promise<Map<string, string>> {
  const actions = new Map<string, string>()
  for (const path of new Bun.Glob('.github/workflows/*.{yml,yaml}').scanSync('.')) {
    const source = await Bun.file(path).text()
    for (const [, repository, version] of source.matchAll(
      /\buses:\s*([\w.-]+\/[\w.-]+)@(v?[\w.-]+)/gu
    )) {
      const existing = actions.get(repository)
      if (existing && existing !== version)
        drift.push(
          `GitHub Action ${repository} uses inconsistent versions \`${existing}\` and \`${version}\`.`
        )
      actions.set(repository, version)
    }
  }
  return actions
}

async function compareRedisRelease(expected: string): Promise<void> {
  try {
    const response = await fetch('https://download.redis.io/releases/', {
      headers: { 'user-agent': headers['user-agent'] }
    })
    if (!response.ok) throw new Error(`release index returned ${response.status}`)
    const versions = [...(await response.text()).matchAll(/redis-(\d+\.\d+\.\d+)\.tar\.gz/gu)].map(
      ([, version]) => version
    )
    const latest = versions.sort(compareVersions).at(-1)
    if (!latest) throw new Error('release index contained no stable versions')
    observations.push(`redis: \`${latest}\``)
    if (latest !== expected)
      drift.push(`Redis advanced beyond reviewed release \`${expected}\` to \`${latest}\`.`)
  } catch (error) {
    drift.push(`Redis release metadata is unavailable: ${errorMessage(error)}.`)
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

async function githubJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`)
  return (await response.json()) as Record<string, unknown>
}

async function githubValue(url: string, select: (value: Record<string, string>) => string) {
  const value = await githubJson(url)
  const selected = select(value as Record<string, string>)
  if (!selected) throw new Error('GitHub response omitted the requested value')
  return selected
}

async function verifySource(source: Source): Promise<void> {
  const url = source.url ?? pinnedGithubUrl(source)
  let response: Response
  try {
    response = await fetch(url, { headers })
  } catch (error) {
    drift.push(`Pinned source is unavailable (${errorMessage(error)}): \`${source.path}\`.`)
    return
  }
  if (!response.ok) {
    drift.push(`Pinned source is unavailable (${response.status}): \`${source.path}\`.`)
    return
  }
  const hash = new Bun.CryptoHasher('sha256').update(await response.arrayBuffer()).digest('hex')
  if (hash !== source.sha256) {
    drift.push(`Pinned source hash changed unexpectedly: \`${source.path}\`.`)
  }
}

function collectManifestRecords(manifest: unknown): ManifestRecord[] {
  const records: ManifestRecord[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if ('source' in value || 'availability' in value) records.push(value as ManifestRecord)
    for (const child of Object.values(value)) visit(child)
  }
  visit(manifest)
  return records
}

function uniqueSources(records: ManifestRecord[]): Source[] {
  return Array.from(
    new Map(
      records
        .filter((record): record is ManifestRecord & { source: Source } => Boolean(record.source))
        .map((record) => [sourceKey(record.source), record.source])
    ).values()
  )
}

function groupSourcesByRepository(records: ManifestRecord[]): Map<string, Source[]> {
  const grouped = new Map<string, Source[]>()
  for (const source of uniqueSources(records)) {
    if (!source.repository || !source.revision) continue
    const group = grouped.get(source.repository) ?? []
    group.push(source)
    grouped.set(source.repository, group)
  }
  return grouped
}

function uniquePackageSources(records: ManifestRecord[]): Source[] {
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

function pinnedGithubUrl(source: Source): string {
  if (!source.repository || !source.revision)
    throw new TypeError(`Pinned source ${source.path} has no URL or Git revision`)
  const repository = new URL(source.repository).pathname.replace(/^\//u, '').replace(/\.git$/u, '')
  return `https://raw.githubusercontent.com/${repository}/${source.revision}/${source.path}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
