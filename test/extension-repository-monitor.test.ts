import { describe, expect, test } from 'bun:test'
import {
  auditMcpExtensionRepositories,
  type GitHubRepositorySummary
} from '../scripts/extension-repository-monitor.js'

function repository(name: string): GitHubRepositorySummary {
  return {
    full_name: `modelcontextprotocol/${name}`,
    html_url: `https://github.com/modelcontextprotocol/${name}`
  }
}

describe('MCP extension repository monitoring', () => {
  test('discovers extension repositories across pages and reports only unreviewed entries', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => repository(`unrelated-${index}`))
    firstPage[0] = repository('ext-skills')
    const pages = new Map<number, GitHubRepositorySummary[]>([
      [1, firstPage],
      [2, [repository('experimental-ext-filesystems'), repository('experimental-ext-new')]]
    ])

    const audit = await auditMcpExtensionRepositories(
      async (page) => pages.get(page) ?? [],
      new Set([
        'https://github.com/modelcontextprotocol/ext-skills',
        'https://github.com/modelcontextprotocol/experimental-ext-filesystems'
      ])
    )

    expect(audit.repositories).toEqual([
      'https://github.com/modelcontextprotocol/experimental-ext-filesystems',
      'https://github.com/modelcontextprotocol/experimental-ext-new',
      'https://github.com/modelcontextprotocol/ext-skills'
    ])
    expect(audit.drift).toEqual([
      'Unreviewed MCP extension repository discovered: `https://github.com/modelcontextprotocol/experimental-ext-new`.'
    ])
  })

  test('distinguishes repository discovery failures from reviewed undefined contracts', async () => {
    const undefinedContract = await auditMcpExtensionRepositories(
      async () => [repository('experimental-ext-filesystems')],
      new Set(['https://github.com/modelcontextprotocol/experimental-ext-filesystems'])
    )
    expect(undefinedContract.drift).toEqual([])

    await expect(
      auditMcpExtensionRepositories(async () => {
        throw new Error('fixture outage')
      }, new Set())
    ).rejects.toThrow('fixture outage')
  })
})
