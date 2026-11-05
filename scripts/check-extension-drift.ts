import {
  isMcpServerSpecificationEligible,
  MCP_SPECIFICATION_GOVERNANCE_SOURCES,
  MCP_SPECIFICATION_INVENTORY,
  MCP_SPECIFICATION_PROPOSAL_HEADS
} from '../src/extensions/governance.js'
import { MCP_EXTENSION_LATEST_REVIEWED, MCP_EXTENSION_SUPPORT } from '../src/extensions/manifest.js'
import {
  auditMcpExtensionRepositories,
  type GitHubRepositorySummary
} from './extension-repository-monitor.js'
import {
  collectManifestRecords,
  groupSourcesByRepository,
  type ManifestRecord,
  pinnedGithubUrl,
  type Source,
  uniquePackageSources,
  uniqueSources
} from './manifest-sources.js'
import {
  readUpstreamBytes,
  readUpstreamJson,
  readUpstreamText,
  registryLatestVersion,
  upstreamString
} from './upstream-http.js'

const token = process.env.GH_TOKEN
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'elysia-mcp-adapter-extension-watch',
  ...(token ? { authorization: `Bearer ${token}` } : {})
}
const sourceHeaders = { 'user-agent': headers['user-agent'] }
const drift: string[] = []
const observations: string[] = []
const compatibilityRecords = collectManifestRecords(MCP_EXTENSION_SUPPORT)
const governanceRecords = collectManifestRecords(MCP_SPECIFICATION_GOVERNANCE_SOURCES)
const records = [...collectManifestRecords(MCP_EXTENSION_LATEST_REVIEWED), ...governanceRecords]
const historicalPaths = new Set<string>([
  MCP_EXTENSION_LATEST_REVIEWED.authClientCredentials.source.path,
  MCP_EXTENSION_LATEST_REVIEWED.authEnterprise.source.path,
  MCP_EXTENSION_LATEST_REVIEWED.skillsStable.source.path
])
const activeRecords = records.filter(({ source }) => !source || !historicalPaths.has(source.path))

for (const [name, record] of Object.entries(MCP_SPECIFICATION_INVENTORY)) {
  const eligible = isMcpServerSpecificationEligible(record)
  observations.push(`${name}: ${record.stage}, ${record.approval}, ${record.disposition}`)
  if ((record.disposition === 'planned' || record.disposition === 'implemented') && !eligible)
    drift.push(`The ${name} server contract is missing implementation authority.`)
}
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
      `Authoritative source is unavailable for ${manifestRecordLabel(record)}: ${record.reason ?? 'no reason recorded'}`
    )
  }
}

function manifestRecordLabel(record: ManifestRecord): string {
  const source = record.source ?? { path: 'unnamed record' }
  return [record.identifier, source.repository, source.path, 'unnamed record'].find(
    (label) => label !== undefined
  ) as string
}

try {
  const reviewedRepositories = new Set(
    uniqueSources([...compatibilityRecords, ...records])
      .map((source) => source.repository?.replace(/\.git$/u, ''))
      .filter((repository): repository is string => repository !== undefined)
  )
  const repositoryAudit = await auditMcpExtensionRepositories(async (page) => {
    const response = await fetch(
      `https://api.github.com/orgs/modelcontextprotocol/repos?type=public&per_page=100&page=${page}`,
      { headers }
    )
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`)
    const value = (await response.json()) as unknown
    if (!Array.isArray(value)) throw new Error('GitHub response was not a repository list')
    return value as GitHubRepositorySummary[]
  }, reviewedRepositories)
  observations.push(
    `MCP extension repositories: ${repositoryAudit.repositories.map((repository) => `\`${repository}\``).join(', ')}`
  )
  drift.push(...repositoryAudit.drift)
} catch (error) {
  drift.push(`Extension repository discovery is unavailable: ${errorMessage(error)}.`)
}

// Integrity-check historical pins. Compare only active paths with upstream head bytes.
for (const source of uniqueSources([...compatibilityRecords, ...records]))
  await verifySource(source)
for (const [repository, sources] of groupSourcesByRepository(activeRecords)) {
  await compareRepositoryHead(repository, sources)
}
for (const proposal of MCP_SPECIFICATION_PROPOSAL_HEADS) await compareProposal(proposal)
const currentPackages = new Map(
  uniquePackageSources(activeRecords).map((source) => [source.packageName, source])
)
for (const source of currentPackages.values()) await compareNpmPackage(source)
for (const dependency of await declaredRegistryDependencies(packageManifestPaths))
  await compareDeclaredPackage(dependency)
for (const [repository, version] of await declaredActions())
  await compareGithubRelease(repository, version, githubActionMajor)
await compareGithubRelease('oven-sh/bun', 'bun-v1.4.4')
await compareRedisRelease('8.10.3')

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

async function compareProposal(proposal: (typeof MCP_SPECIFICATION_PROPOSAL_HEADS)[number]) {
  const { repository, number, pin, accepted } = proposal
  const label = `${repository}#${number}`
  try {
    const metadata = await githubJson(`https://api.github.com/repos/${repository}/pulls/${number}`)
    if (proposalStatusChanged(metadata, accepted))
      drift.push(`Proposal ${label} changed state or approval and needs review.`)
    if (await sourceChangedAt(pin, proposalRevision(metadata)))
      drift.push(`Proposal ${label} changed its specification bytes.`)
  } catch (error) {
    drift.push(`Proposal ${label} is unavailable: ${errorMessage(error)}.`)
  }
}

function proposalStatusChanged(metadata: Record<string, unknown>, accepted: boolean): boolean {
  const hasApproval =
    Array.isArray(metadata.labels) && metadata.labels.some((item) => item?.name === 'accepted')
  return metadata.state !== 'open' || hasApproval !== accepted
}

function proposalRevision(metadata: Record<string, unknown>): string {
  const head = metadata.head as { sha?: unknown } | undefined
  const revision = upstreamString(head?.sha, 'proposal head SHA')
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error('Invalid proposal head SHA')
  return revision
}

async function compareRepositoryHead(repository: string, sources: Source[]): Promise<void> {
  const headSources = [
    ...new Map(
      sources.filter((source) => source.trackHead !== false).map((source) => [source.path, source])
    ).values()
  ]
  if (headSources.length === 0) return
  const repositoryPath = new URL(repository).pathname.replace(/^\//u, '').replace(/\.git$/u, '')
  const branch = await repositoryDefaultBranch(repositoryPath)
  let current: string
  try {
    current = await repositoryHead(repository, repositoryPath, branch)
  } catch (error) {
    drift.push(`Repository head is unavailable (${errorMessage(error)}): \`${repository}\`.`)
    return
  }
  observations.push(`${repositoryPath} ${branch}: \`${current}\``)
  for (const source of headSources) await compareHeadSource(repositoryPath, source, current)
}

async function compareHeadSource(repository: string, source: Source, revision: string) {
  const label = `${repository}/${source.path}`
  try {
    if (await sourceChangedAt(source, revision))
      drift.push(`Upstream contract changed at \`${label}\` (head \`${revision}\`).`)
  } catch (error) {
    drift.push(`Current source is unavailable at \`${label}\`: ${errorMessage(error)}.`)
  }
}

async function sourceChangedAt(source: Source, revision: string): Promise<boolean> {
  if (revision === source.revision) return false
  const url = pinnedGithubUrl({ ...source, revision })
  return hashSource(await readUpstreamBytes(url, sourceHeaders)) !== source.sha256
}

async function repositoryDefaultBranch(repositoryPath: string): Promise<string> {
  try {
    const metadata = await githubJson(`https://api.github.com/repos/${repositoryPath}`)
    return typeof metadata.default_branch === 'string' ? metadata.default_branch : 'main'
  } catch {
    return 'main'
  }
}

async function repositoryHead(
  repository: string,
  repositoryPath: string,
  branch: string
): Promise<string> {
  try {
    return await githubValue(
      `https://api.github.com/repos/${repositoryPath}/commits/${encodeURIComponent(branch)}`,
      (value) => value.sha
    )
  } catch {
    return gitRepositoryHead(repository, branch)
  }
}

async function gitRepositoryHead(repository: string, branch: string): Promise<string> {
  const process = Bun.spawn(['git', 'ls-remote', repository, `refs/heads/${branch}`], {
    stderr: 'pipe',
    stdout: 'pipe'
  })
  const output = (await new Response(process.stdout).text()).trim()
  const exitCode = await process.exited
  const sha = output.split(/\s+/u)[0] ?? ''
  if (exitCode !== 0 || !/^[0-9a-f]{40}$/iu.test(sha)) {
    const error = await new Response(process.stderr).text()
    throw gitHeadFailure(error, exitCode)
  }
  return sha
}

function gitHeadFailure(error: string, exitCode: number): Error {
  return new Error(error.trim() || `git ls-remote exited with ${exitCode}`)
}

async function compareNpmPackage(source: Source): Promise<void> {
  try {
    const name = upstreamString(source.packageName, 'package name')
    const current = await registryLatestVersion(name, headers)
    observations.push(`${name}: \`${current}\` (reviewed: \`${source.packageVersion}\`)`)
    if (current !== source.packageVersion)
      drift.push(
        `Package advanced beyond ${name} (reviewed \`${source.packageVersion}\`, latest \`${current}\`).`
      )
  } catch (error) {
    drift.push(
      `Package source is unavailable (${errorMessage(error)}): ${source.packageName} (reviewed ${source.packageVersion}).`
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
      recordDeclaredDependency(dependencies, name, range, path)
    }
  }
  return [...dependencies.values()]
}

function recordDeclaredDependency(
  dependencies: Map<string, DeclaredDependency>,
  name: string,
  range: string,
  path: string
): void {
  if (/^(?:link:|workspace:|file:)/u.test(range)) return
  const version = range.replace(/^[~^]/u, '')
  const key = `${name}\0${version}`
  const existing = dependencies.get(key)
  if (existing) existing.manifests.push(path)
  else dependencies.set(key, { name, version, manifests: [path] })
}

async function compareDeclaredPackage(dependency: DeclaredDependency): Promise<void> {
  try {
    const latest = await registryLatestVersion(dependency.name, headers)
    observations.push(`${dependency.name}: \`${latest}\``)
    if (latest !== dependency.version)
      drift.push(
        `Declared dependency ${dependency.name} is \`${dependency.version}\`, latest is \`${latest}\` (${dependency.manifests.join(', ')}).`
      )
  } catch (error) {
    drift.push(`Dependency registry is unavailable for ${dependency.name}: ${errorMessage(error)}.`)
  }
}

async function compareGithubRelease(
  repository: string,
  expected: string,
  normalize: (tag: string) => string | undefined = (tag) => tag
): Promise<void> {
  try {
    const latest = await githubValue(
      `https://api.github.com/repos/${repository}/releases/latest`,
      (value) => value.tag_name
    )
    observations.push(`${repository}: \`${latest}\``)
    if (normalize(latest) !== expected)
      drift.push(`${repository} advanced beyond reviewed release \`${expected}\` to \`${latest}\`.`)
  } catch (error) {
    drift.push(`Release metadata is unavailable for ${repository}: ${errorMessage(error)}.`)
  }
}

function githubActionMajor(tag: string): string | undefined {
  return /^v[0-9]+(?=\.|$)/u.exec(tag)?.[0]
}

async function declaredActions(): Promise<Map<string, string>> {
  const actions = new Map<string, string>()
  for (const path of new Bun.Glob('.github/workflows/*.{yml,yaml}').scanSync('.')) {
    const source = await Bun.file(path).text()
    for (const [, repository, version] of source.matchAll(
      /\buses:\s*['"]?([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([\w.-]+)/gu
    )) {
      recordActionVersion(actions, repository, version)
    }
  }
  return actions
}

function recordActionVersion(
  actions: Map<string, string>,
  repository: string,
  version: string
): void {
  if (!/^v[0-9]+$/u.test(version))
    drift.push(`GitHub Action ${repository} must use a major tag; found \`${version}\`.`)
  const existing = actions.get(repository)
  if (existing && existing !== version)
    drift.push(
      `GitHub Action ${repository} uses inconsistent versions \`${existing}\` and \`${version}\`.`
    )
  actions.set(repository, version)
}

async function compareRedisRelease(expected: string): Promise<void> {
  try {
    const index = await readUpstreamText('https://download.redis.io/releases/', {
      'user-agent': headers['user-agent']
    })
    const versions = [...index.matchAll(/redis-(\d+\.\d+\.\d+)\.tar\.gz/gu)].map(
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
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(a.at(index)) - Number(b.at(index))
    if (difference !== 0) return difference
  }
  return 0
}

async function githubJson(url: string): Promise<Record<string, unknown>> {
  return readUpstreamJson(url, headers)
}

async function githubValue(url: string, select: (value: Record<string, string>) => string) {
  const value = await githubJson(url)
  const selected = select(value as Record<string, string>)
  if (!selected) throw new Error('GitHub response omitted the requested value')
  return selected
}

async function verifySource(source: Source): Promise<void> {
  const url = source.url ?? pinnedGithubUrl(source)
  try {
    const bytes = await readUpstreamBytes(url, sourceHeaders)
    if (hashSource(bytes) !== source.sha256)
      drift.push(`Pinned source hash changed unexpectedly: \`${source.path}\`.`)
  } catch (error) {
    drift.push(`Pinned source is unavailable (${errorMessage(error)}): \`${source.path}\`.`)
  }
}

function hashSource(bytes: ArrayBuffer): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
