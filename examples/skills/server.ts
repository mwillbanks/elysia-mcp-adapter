import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

const skillUrl = new URL('./skill/release-helper/SKILL.md', import.meta.url)
const referenceUrl = new URL('./skill/release-helper/references/VERIFY.md', import.meta.url)
const emptyReferenceUrl = new URL('./skill/release-helper/references/EMPTY.txt', import.meta.url)

export const app = new Elysia()
  .use(
    mcp({
      server: { name: 'skills-example', version: '1.0.0' },
      allowedRoutes: [],
      extensions: {
        skills: {
          directoryRead: true,
          pagination: {
            pageSize: 1,
            signingKey: 'skills-example-pagination-key-0001'
          }
        }
      }
    })
  )
  .mcpSkill(
    'skill://pagination-proof/SKILL.md',
    '---\nname: pagination-proof\ndescription: Exercise paginated skill discovery\n---\n\n# Pagination proof\n'
  )
  .mcpSkill(
    'skill://release-helper/SKILL.md',
    new Uint8Array(await Bun.file(skillUrl).arrayBuffer()),
    {
      resources: {
        'references/VERIFY.md': {
          content: new Uint8Array(await Bun.file(referenceUrl).arrayBuffer()),
          mimeType: 'text/markdown'
        },
        'references/EMPTY.txt': {
          content: new Uint8Array(await Bun.file(emptyReferenceUrl).arrayBuffer()),
          mimeType: 'text/plain'
        }
      }
    }
  )
  .mcpSkill(
    'skill://direct-lookup/SKILL.md',
    '---\nname: direct-lookup\ndescription: Demonstrate direct retrieval outside skills/list\n---\n\n# Direct lookup\n',
    { listed: false }
  )
