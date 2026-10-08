export interface GitHubRepositorySummary {
  full_name: string
  html_url: string
}

export interface ExtensionRepositoryAudit {
  repositories: string[]
  drift: string[]
}

type RepositoryPageReader = (page: number) => Promise<readonly GitHubRepositorySummary[]>

const PAGE_SIZE = 100
const MAX_PAGES = 10

export async function auditMcpExtensionRepositories(
  readPage: RepositoryPageReader,
  reviewedRepositories: ReadonlySet<string>
): Promise<ExtensionRepositoryAudit> {
  const repositories: string[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const entries = await readPage(page)
    for (const repository of entries) {
      if (!isExtensionRepository(repository.full_name)) continue
      repositories.push(repository.html_url.replace(/\.git$/u, ''))
    }
    if (entries.length < PAGE_SIZE) {
      const discovered = [...new Set(repositories)].sort()
      return {
        repositories: discovered,
        drift: discovered
          .filter((repository) => !reviewedRepositories.has(repository))
          .map((repository) => `Unreviewed MCP extension repository discovered: \`${repository}\`.`)
      }
    }
  }
  throw new Error(`MCP extension repository discovery exceeded ${MAX_PAGES} pages`)
}

function isExtensionRepository(fullName: string): boolean {
  const [organization, name, extra] = fullName.split('/')
  return (
    extra === undefined &&
    organization === 'modelcontextprotocol' &&
    name !== undefined &&
    (name.startsWith('ext-') || name.startsWith('experimental-ext-'))
  )
}
