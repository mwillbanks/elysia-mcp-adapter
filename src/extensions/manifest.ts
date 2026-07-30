export type McpExtensionStatus = 'stable' | 'draft' | 'experimental'

export interface McpExtensionSource {
  repository: string
  revision: string
  path: string
  sha256: string
  packageVersion?: string
}

export interface McpExtensionVersionRecord {
  status: McpExtensionStatus
  includedAt: string
  source: McpExtensionSource
}

export const MCP_EXTENSION_SUPPORT = {
  protocol: {
    current: '2026-07-28',
    supported: ['2026-07-28', '2025-11-25'],
    versions: {
      '2026-07-28': {
        status: 'stable',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: '5f5440bb26a62e2cf3440b92da5a667efa03b267',
          path: 'schema/2026-07-28/schema.json',
          sha256: 'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203'
        }
      },
      '2025-11-25': {
        status: 'stable',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: '38c84e9f93ad191d9eb26d92b945d17bd0efcaf3',
          path: 'schema/2025-11-25/schema.json',
          sha256: '1ffe4c5577974012f5fa02af14ea88df4b7146679df1abaaad497c8d9230ca8a'
        }
      }
    }
  },
  tasks: {
    identifier: 'io.modelcontextprotocol/tasks',
    current: '2026-07-28',
    draft: 'draft',
    versions: {
      '2026-07-28': {
        status: 'stable',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: '5f5440bb26a62e2cf3440b92da5a667efa03b267',
          path: 'seps/2663-tasks-extension.md',
          sha256: 'f311ca76f5d10545cf422a947af4f8a257f197cdd0ec6709b5fee0a2a65bcf80'
        }
      },
      draft: {
        status: 'draft',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/ext-tasks',
          revision: '2c1425d9a288b9b1f489430fe1e00bb392b47e48',
          path: 'specification/draft/tasks.md',
          sha256: 'ae908a883d8489f1ebfee47496dd8818f182b467a4196c17df98b40a3d8b2b11'
        }
      }
    }
  },
  auth: {
    identifier: 'mcp-authorization',
    current: '2026-07-28',
    versions: {
      '2026-07-28': {
        status: 'stable',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: '5f5440bb26a62e2cf3440b92da5a667efa03b267',
          path: 'docs/specification/2026-07-28/basic/authorization/index.mdx',
          sha256: 'e31841f18b21f83f984689c0b0409577139cc50b698ce7c8fbd09a8c920a5241'
        }
      },
      draft: {
        status: 'draft',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: '41d9e938e9a9edf23a69429be180cad172e00f4e',
          path: 'docs/specification/draft/basic/authorization/index.mdx',
          sha256: '7559c591b265ef71549f02775423c8c1ae152028601ee331da12f66bec0baa55'
        }
      },
      '2025-11-25': {
        status: 'stable',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: '38c84e9f93ad191d9eb26d92b945d17bd0efcaf3',
          path: 'docs/specification/2025-11-25/basic/authorization.mdx',
          sha256: '8182f6a204013b497369c2ad690ff313f8bd1d2ce9ebb68e8f5d0392aa348cb9'
        }
      },
      '2025-06-18': {
        status: 'stable',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: 'f5ccad944fdf2b7d9cc70cf817f66ca5a8aa03a4',
          path: 'docs/specification/2025-06-18/basic/authorization.mdx',
          sha256: 'f9a7ebfc5e56aa9717934aaaf5e9dd0310fcfdc942b21b09248653adeb723025'
        }
      }
    },
    clientCredentials: {
      identifier: 'io.modelcontextprotocol/oauth-client-credentials',
      current: 'draft',
      draft: 'draft',
      versions: {
        draft: {
          status: 'draft',
          includedAt: '2026-07-30',
          source: {
            repository: 'https://github.com/modelcontextprotocol/ext-auth',
            revision: 'fb374c7db2b34f18ca9183882e0beecdf661892b',
            path: 'specification/draft/oauth-client-credentials.mdx',
            sha256: '5db1ffb20f0f33ddbebd6e9747be20c1be3a395a1bd1faad3719334c35a70d3f'
          }
        }
      }
    },
    enterpriseManagedAuthorization: {
      identifier: 'io.modelcontextprotocol/enterprise-managed-authorization',
      current: '2026-06-17',
      versions: {
        '2026-06-17': {
          status: 'stable',
          includedAt: '2026-07-30',
          source: {
            repository: 'https://github.com/modelcontextprotocol/ext-auth',
            revision: 'fb374c7db2b34f18ca9183882e0beecdf661892b',
            path: 'specification/stable/enterprise-managed-authorization.mdx',
            sha256: 'df4fe01daec0eac6069e17a293d4ed7e197ab20463038d806f71e63b22fd8986'
          }
        }
      }
    }
  },
  apps: {
    identifier: 'io.modelcontextprotocol/ui',
    current: '2026-01-26',
    draft: 'draft',
    versions: {
      '2026-01-26': {
        status: 'stable',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/ext-apps',
          revision: 'v1.7.5',
          path: 'specification/2026-01-26/apps.mdx',
          sha256: 'ee452a7d1b9b7fb900acfeb4d6932d3963375b0f3f37d196a4b93eb80312af0e',
          packageVersion: '1.7.5'
        }
      },
      draft: {
        status: 'draft',
        includedAt: '2026-07-30',
        source: {
          repository: 'https://github.com/modelcontextprotocol/ext-apps',
          revision: 'v1.7.5',
          path: 'specification/draft/apps.mdx',
          sha256: '00e97500a71cd46f27a0c661a3c9ee4df60cf64ba7b069e41227ddf8d41b4269',
          packageVersion: '1.7.5'
        }
      }
    }
  }
} as const satisfies Record<string, unknown>

export type McpProtocolVersion = (typeof MCP_EXTENSION_SUPPORT.protocol.supported)[number]

export function resolvePinnedVersion<T extends Record<string, unknown>>(
  label: string,
  requested: string | undefined,
  current: keyof T & string,
  versions: T
): keyof T & string {
  const candidate = requested === undefined || requested === 'current' ? current : requested
  if (candidate in versions) return candidate as keyof T & string

  const supported = ['current', ...Object.keys(versions)].join(', ')
  throw new TypeError(
    `Unsupported ${label} specification version "${candidate}". Supported: ${supported}`
  )
}
