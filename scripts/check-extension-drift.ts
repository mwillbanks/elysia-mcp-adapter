import { MCP_EXTENSION_SUPPORT } from '../src/extensions/manifest.js'

type Source = {
  repository: string
  revision: string
  path: string
  sha256: string
}

const token = process.env.GH_TOKEN
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'elysia-mcp-adapter-extension-watch',
  ...(token ? { authorization: `Bearer ${token}` } : {})
}
const drift: string[] = []
const observations: string[] = []

await compareHead(
  'Core main',
  'modelcontextprotocol/modelcontextprotocol',
  MCP_EXTENSION_SUPPORT.protocol.versions['2026-07-28'].source.revision
)
await compareHead(
  'Tasks main',
  'modelcontextprotocol/ext-tasks',
  MCP_EXTENSION_SUPPORT.tasks.versions.draft.source.revision
)
await compareHead(
  'Auth main',
  'modelcontextprotocol/ext-auth',
  MCP_EXTENSION_SUPPORT.auth.clientCredentials.versions.draft.source.revision
)
await compareHeadToTag(
  'Apps main',
  'modelcontextprotocol/ext-apps',
  MCP_EXTENSION_SUPPORT.apps.versions['2026-01-26'].source.revision
)
await compareNpmPackage(
  'Apps npm release',
  '@modelcontextprotocol/ext-apps',
  MCP_EXTENSION_SUPPORT.apps.versions['2026-01-26'].source.packageVersion
)

for (const source of extensionSources()) await verifySource(source)

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

async function compareHead(label: string, repository: string, pinned: string): Promise<void> {
  const current = await githubValue(
    `https://api.github.com/repos/${repository}/commits/main`,
    (value) => value.sha
  )
  observations.push(`${label}: \`${current}\` (reviewed: \`${pinned}\`)`)
  if (current !== pinned) drift.push(`${label} advanced beyond the reviewed revision.`)
}

async function compareHeadToTag(label: string, repository: string, tag: string): Promise<void> {
  const pinned = await githubValue(
    `https://api.github.com/repos/${repository}/commits/${tag}`,
    (value) => value.sha
  )
  await compareHead(label, repository, pinned)
}

async function compareNpmPackage(
  label: string,
  packageName: string,
  pinned: string
): Promise<void> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    { headers: { accept: 'application/json', 'user-agent': headers['user-agent'] } }
  )
  if (!response.ok) {
    drift.push(`${label} could not be checked (${response.status}).`)
    return
  }
  const current = ((await response.json()) as { version?: unknown }).version
  if (typeof current !== 'string') {
    drift.push(`${label} returned an invalid package document.`)
    return
  }
  observations.push(`${label}: \`${current}\` (reviewed: \`${pinned}\`)`)
  if (current !== pinned) drift.push(`${label} advanced beyond the reviewed package version.`)
}

async function githubValue(url: string, select: (value: Record<string, string>) => string) {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${url}`)
  return select((await response.json()) as Record<string, string>)
}

async function verifySource(source: Source): Promise<void> {
  const repository = new URL(source.repository).pathname.replace(/^\/|\.git$/gu, '')
  const url = `https://raw.githubusercontent.com/${repository}/${source.revision}/${source.path}`
  const response = await fetch(url, { headers })
  if (!response.ok) {
    drift.push(`Pinned source is unavailable (${response.status}): \`${source.path}\`.`)
    return
  }
  const hash = new Bun.CryptoHasher('sha256').update(await response.arrayBuffer()).digest('hex')
  if (hash !== source.sha256) {
    drift.push(`Pinned source hash changed unexpectedly: \`${source.path}\`.`)
  }
}

function extensionSources(): Source[] {
  const records = [
    ...Object.values(MCP_EXTENSION_SUPPORT.protocol.versions),
    ...Object.values(MCP_EXTENSION_SUPPORT.tasks.versions),
    ...Object.values(MCP_EXTENSION_SUPPORT.auth.versions),
    ...Object.values(MCP_EXTENSION_SUPPORT.auth.clientCredentials.versions),
    ...Object.values(MCP_EXTENSION_SUPPORT.auth.enterpriseManagedAuthorization.versions),
    ...Object.values(MCP_EXTENSION_SUPPORT.apps.versions)
  ]
  return Array.from(
    new Map(
      records.map((record) => [
        `${record.source.repository}\0${record.source.revision}\0${record.source.path}`,
        record.source
      ])
    ).values()
  )
}
