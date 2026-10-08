import { describe, expect, test } from 'bun:test'
import {
  collectManifestRecords,
  groupSourcesByRepository,
  pinnedGithubUrl,
  type Source,
  uniquePackageSources,
  uniqueSources
} from '../scripts/manifest-sources.js'

const source: Source = {
  repository: 'https://github.com/modelcontextprotocol/ext-skills.git',
  revision: 'reviewed-commit',
  path: 'specification/stable/skills.mdx',
  sha256: 'fixture-digest'
}

describe('manifest source inventory', () => {
  test('finds nested records and deduplicates identical pins without conflating revisions', () => {
    const records = collectManifestRecords({
      versions: [
        { source },
        { source: { ...source } },
        { source: { ...source, revision: 'older-commit' } }
      ],
      pending: { availability: 'unavailable', reason: 'fixture outage' }
    })
    expect(records).toHaveLength(4)
    expect(uniqueSources(records).map((entry) => entry.revision)).toEqual([
      'reviewed-commit',
      'older-commit'
    ])
    expect(
      groupSourcesByRepository(records).get(
        'https://github.com/modelcontextprotocol/ext-skills.git'
      )
    ).toHaveLength(2)
  })

  test('keeps directly pinned URLs out of repository head checks', () => {
    const records = [
      {
        source: { url: 'https://example.test/schema.json', path: 'schema.json', sha256: 'fixture' }
      }
    ]
    expect(uniqueSources(records)).toHaveLength(1)
    expect(groupSourcesByRepository(records).size).toBe(0)
  })

  test('checks each package version once while retaining independently pinned sources', () => {
    const packageSource = {
      ...source,
      packageName: '@modelcontextprotocol/ext-skills',
      packageVersion: '1.0.0'
    }
    const records = [
      { source: packageSource },
      { source: { ...packageSource, path: 'another.md' } },
      { source },
      { source: { ...packageSource, packageVersion: '2.0.0' } }
    ]
    expect(
      uniquePackageSources(records)
        .map((entry) => entry.packageVersion)
        .sort()
    ).toEqual(['1.0.0', '2.0.0'])
  })

  test('constructs immutable raw URLs and refuses unpinned repository sources', () => {
    expect(pinnedGithubUrl(source)).toBe(
      'https://raw.githubusercontent.com/modelcontextprotocol/ext-skills/reviewed-commit/specification/stable/skills.mdx'
    )
    expect(() => pinnedGithubUrl({ path: 'schema.json', sha256: 'fixture' })).toThrow(
      'has no URL or Git revision'
    )
  })
})
