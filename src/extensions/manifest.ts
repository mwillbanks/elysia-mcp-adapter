export type McpExtensionStatus = 'stable' | 'draft' | 'experimental'

export interface McpExtensionSource {
  repository?: string
  revision?: string
  url?: string
  path: string
  sha256: string
  packageVersion?: string
  packageName?: string
  trackHead?: boolean
}

export interface McpExtensionVersionRecord {
  status: McpExtensionStatus
  includedAt: string
  source: McpExtensionSource
}

/**
 * A reviewed upstream source that is tracked for implementation planning.
 *
 * These records are deliberately separate from MCP_EXTENSION_SUPPORT. A source
 * can be current upstream without being implemented by this adapter yet.
 */
export type McpExtensionMaturity = 'stable' | 'draft' | 'experimental' | 'undefined'

export interface McpLatestExtensionRecord {
  identifier?: string
  maturity: McpExtensionMaturity
  protocolEra?: string
  availability: 'reviewed' | 'unavailable'
  source?: McpExtensionSource
  reason?: string
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
      },
      'draft-5246bc3': {
        status: 'draft',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/ext-tasks',
          revision: '5246bc3d0253c1c4b09e682f690b7e8b97362500',
          path: 'specification/draft/tasks.md',
          sha256: '7fd574093a5c4e29da19a0d7683693af7b93a276f3ce37343664c9e12f4d039a',
          packageVersion: '0.2.2',
          packageName: '@modelcontextprotocol/ext-tasks'
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
  },
  skills: {
    identifier: 'io.modelcontextprotocol/skills',
    current: '167da6c0d42c247a8f8470228a10ca711e3f6c45',
    versions: {
      '167da6c0d42c247a8f8470228a10ca711e3f6c45': {
        status: 'stable',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/ext-skills',
          revision: '167da6c0d42c247a8f8470228a10ca711e3f6c45',
          path: 'specification/stable/skills.mdx',
          sha256: 'b8b4c2faf0ef38d72114b8ea2c4e29bbba1d30151b8dc3b476ca31f685de610c'
        }
      }
    }
  },
  serverCard: {
    identifier: 'io.modelcontextprotocol/server-card',
    maturity: 'stable',
    current: '526201bbc80231daa40ffcdecfc9da4e54e5dc93',
    versions: {
      '526201bbc80231daa40ffcdecfc9da4e54e5dc93': {
        status: 'experimental',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/ext-server-card',
          revision: '526201bbc80231daa40ffcdecfc9da4e54e5dc93',
          path: 'schema.json',
          sha256: '2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042'
        }
      }
    }
  },
  interceptors: {
    identifier: 'io.modelcontextprotocol/interceptors',
    current: 'b60459844cc95f2170297ebe1c84b7de8b752953',
    versions: {
      b60459844cc95f2170297ebe1c84b7de8b752953: {
        status: 'experimental',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/experimental-ext-interceptors',
          revision: 'b60459844cc95f2170297ebe1c84b7de8b752953',
          path: 'docs/sep.md',
          sha256: '1ccbb25046161f10e631ff4fce20742a816dd5fa018e466a7551cb8675200a35'
        }
      }
    }
  },
  variants: {
    identifier: 'io.modelcontextprotocol/server-variants',
    current: '53448f2fab9ac0fddf602db441245625b598ca4e',
    versions: {
      '53448f2fab9ac0fddf602db441245625b598ca4e': {
        status: 'experimental',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
          revision: '53448f2fab9ac0fddf602db441245625b598ca4e',
          path: 'seps/2053-server-variants.md',
          sha256: 'acb459c128b2b26af772f878919c40d7a7a0c23d364c594c08cf01e733b95d15',
          trackHead: false
        }
      }
    }
  },
  events: {
    identifier: 'io.modelcontextprotocol/events',
    current: '6682596d65eec778fe0b8b1f43b4e89d2fe2c546',
    versions: {
      '6682596d65eec778fe0b8b1f43b4e89d2fe2c546': {
        status: 'experimental',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/experimental-ext-triggers-events',
          revision: '6682596d65eec778fe0b8b1f43b4e89d2fe2c546',
          path: 'docs/design-sketch-proposal.md',
          sha256: 'a4ca4ea18b10e3fe53595c73e593a92d3445ae75897fd8ab15e88bf781efeb5a'
        }
      }
    }
  },
  actionMetadata: {
    identifier: 'io.modelcontextprotocol/action-metadata',
    current: 'fecace78a9552f70ba735d750fc3c4b190e20429',
    versions: {
      fecace78a9552f70ba735d750fc3c4b190e20429: {
        status: 'experimental',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/experimental-ext-tool-annotations',
          revision: 'fecace78a9552f70ba735d750fc3c4b190e20429',
          path: 'specification/draft/action-metadata.mdx',
          sha256: '985a052969d9b8f67b98e46bb564b62960de47c1e43fdf8f8b9eb157bf50532f'
        }
      }
    }
  },
  trustAnnotations: {
    identifier: 'io.modelcontextprotocol/trust-annotations',
    current: 'fecace78a9552f70ba735d750fc3c4b190e20429',
    versions: {
      fecace78a9552f70ba735d750fc3c4b190e20429: {
        status: 'experimental',
        includedAt: '2026-10-01',
        source: {
          repository: 'https://github.com/modelcontextprotocol/experimental-ext-tool-annotations',
          revision: 'fecace78a9552f70ba735d750fc3c4b190e20429',
          path: 'specification/draft/trust-annotations.mdx',
          sha256: '3cc0123157d3ea4489729d8498489e12787297dcfe1f09a5bb02a4a6b0f55b7d'
        }
      }
    }
  }
} as const satisfies Record<string, unknown>

/**
 * Latest upstream records reviewed for the implementation inventory.
 *
 * This is not a support claim. Existing codecs and aliases above remain the
 * compatibility contract until a later implementation work product promotes a
 * reviewed record into MCP_EXTENSION_SUPPORT.
 */
export const MCP_EXTENSION_LATEST_REVIEWED = {
  coreTypeScriptSchema: {
    identifier: 'io.modelcontextprotocol/core-typescript-schema',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'schema/2026-07-28/schema.ts',
      sha256: '742750af0bb8c716e7030c4977c992b55d1adc4407e9e66997db5846baedc2cd'
    }
  },
  coreDraftTypeScriptSchema: {
    identifier: 'io.modelcontextprotocol/core-typescript-schema',
    maturity: 'draft',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'schema/draft/schema.ts',
      sha256: 'b2d3a00d4094e413a48628560fec60652169a3d2b427e8c629238e13f987723f'
    }
  },
  coreSchema: {
    identifier: 'io.modelcontextprotocol/core',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'schema/2026-07-28/schema.json',
      sha256: 'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203'
    }
  },
  coreTools: {
    identifier: 'io.modelcontextprotocol/core-tools',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/tools.mdx',
      sha256: 'ed550806a58eb7744b858fb9f26001aa5e55dac9e2babe88317cc81d9d4c490d'
    }
  },
  coreMrtr: {
    identifier: 'io.modelcontextprotocol/core-mrtr',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/patterns/mrtr.mdx',
      sha256: 'a8671eb2a0d292c0dcbae19666ff4fc3d97f294ce8107e9f38259cc5a02a066b'
    }
  },
  coreAuthorization: {
    identifier: 'mcp-authorization',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/authorization/index.mdx',
      sha256: '99e7eeaecad5381649e6dca98cb5b47f314bdda9f1d8cd989299e5fe143a913e'
    }
  },
  coreDraftSchema: {
    identifier: 'io.modelcontextprotocol/core',
    maturity: 'draft',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'schema/draft/schema.json',
      sha256: 'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203'
    }
  },
  coreBasic: {
    identifier: 'io.modelcontextprotocol/core-basic',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/index.mdx',
      sha256: '03586b10e3214c55478293f1199fffb0bbf95bbef5df3d6a8378e860697bd63f'
    }
  },
  coreVersioning: {
    identifier: 'io.modelcontextprotocol/core-versioning',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/versioning.mdx',
      sha256: 'bc02f271700bdecd88034f2d7801eb09110a71d65876487378d94e48dfeb90dc'
    }
  },
  coreStreamableHttp: {
    identifier: 'io.modelcontextprotocol/core-streamable-http',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/transports/streamable-http.mdx',
      sha256: '22574bf11e004068493787203ce92be1162107cad717bcb805a15780d4fa69c9'
    }
  },
  coreCancellation: {
    identifier: 'io.modelcontextprotocol/core-cancellation',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/patterns/cancellation.mdx',
      sha256: '396030784a4af9b734a1c8d4faed13b31077e4a3a1f03c9c1f2048ec52794ba4'
    }
  },
  coreProgress: {
    identifier: 'io.modelcontextprotocol/core-progress',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/patterns/progress.mdx',
      sha256: '9f55aca08920c633f3a2a35e0c77533db08d3fd19ced43918ea7c57aa5f85409'
    }
  },
  coreSubscriptions: {
    identifier: 'io.modelcontextprotocol/core-subscriptions',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/basic/patterns/subscriptions.mdx',
      sha256: '8333cbc3280cad293e96b4a20c3200face8e185ebf58f1c4a51c35bb96654abd'
    }
  },
  coreDiscover: {
    identifier: 'io.modelcontextprotocol/core-discover',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/discover.mdx',
      sha256: '3fe1f5b5f1528014216b1e49cc3363b3c689c36bcb80a6957ddca6a04cea409c'
    }
  },
  coreResources: {
    identifier: 'io.modelcontextprotocol/core-resources',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/resources.mdx',
      sha256: '10538119019af5f49a2fbc55d5818725175863115dfb273e79ed7f65a18aaf0c'
    }
  },
  corePrompts: {
    identifier: 'io.modelcontextprotocol/core-prompts',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/prompts.mdx',
      sha256: '85e550635bbbbaa90dff8738f98808c62987e8cfce1d75305b55ca43f3c546de'
    }
  },
  coreCompletion: {
    identifier: 'io.modelcontextprotocol/core-completion',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/utilities/completion.mdx',
      sha256: '1965c563aadb99e141131444caa81ff1860ed82bab314b286c40a0f0ba839f99'
    }
  },
  corePagination: {
    identifier: 'io.modelcontextprotocol/core-pagination',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/utilities/pagination.mdx',
      sha256: 'c4c7b674ae9ce16c012b5da35559d35768f6b7a508ceb5d2d71393a9f46afd2b'
    }
  },
  coreCaching: {
    identifier: 'io.modelcontextprotocol/core-caching',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/utilities/caching.mdx',
      sha256: 'ca416e94b40c067de638bb101541969f2b956b33e9695761032ddc06245d514d'
    }
  },
  coreLogging: {
    identifier: 'io.modelcontextprotocol/core-logging',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/server/utilities/logging.mdx',
      sha256: '4e77ec3257e07ad69bfd6ed902771f14d6498b60fe6c9c325b8ff4bfc35647a6'
    }
  },
  coreRoots: {
    identifier: 'io.modelcontextprotocol/core-roots',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/client/roots.mdx',
      sha256: '016aea34d76ccce86a82509dbf2699833bb8547bde5b3f4a8eb086dfd26a9ba2'
    }
  },
  coreSampling: {
    identifier: 'io.modelcontextprotocol/core-sampling',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/client/sampling.mdx',
      sha256: '32fe2bb69f5a7caa85a6b9501f465cb1fb888d0c669cd13b23a071071a029df1'
    }
  },
  coreElicitation: {
    identifier: 'io.modelcontextprotocol/core-elicitation',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'docs/specification/2026-07-28/client/elicitation.mdx',
      sha256: '74351d1081681695536e59a55588a67ed66a76db6057846c263ce2f465fab4c2'
    }
  },
  tasksStable: {
    identifier: 'io.modelcontextprotocol/tasks',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-tasks',
      revision: '93a4915aadf714f87ece5cd40c317bce24779cf5',
      path: 'specification/2026-07-28/tasks.md',
      sha256: 'ef2860ae4418d02f3b2bfd54fcd88b03a3c2c3aa6724d282cd4ca3a3699a2e27',
      packageVersion: '0.2.2',
      packageName: '@modelcontextprotocol/ext-tasks'
    }
  },
  tasksDraft: {
    identifier: 'io.modelcontextprotocol/tasks',
    maturity: 'draft',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-tasks',
      revision: '93a4915aadf714f87ece5cd40c317bce24779cf5',
      path: 'specification/draft/tasks.md',
      sha256: '7fd574093a5c4e29da19a0d7683693af7b93a276f3ce37343664c9e12f4d039a',
      packageVersion: '0.2.2',
      packageName: '@modelcontextprotocol/ext-tasks'
    }
  },
  authEnterprise: {
    identifier: 'io.modelcontextprotocol/enterprise-managed-authorization',
    maturity: 'stable',
    protocolEra: '2026-06-17',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-auth',
      revision: 'fb374c7db2b34f18ca9183882e0beecdf661892b',
      path: 'specification/stable/enterprise-managed-authorization.mdx',
      sha256: 'df4fe01daec0eac6069e17a293d4ed7e197ab20463038d806f71e63b22fd8986'
    }
  },
  authClientCredentials: {
    identifier: 'io.modelcontextprotocol/oauth-client-credentials',
    maturity: 'draft',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-auth',
      revision: 'fb374c7db2b34f18ca9183882e0beecdf661892b',
      path: 'specification/draft/oauth-client-credentials.mdx',
      sha256: '5db1ffb20f0f33ddbebd6e9747be20c1be3a395a1bd1faad3719334c35a70d3f'
    }
  },
  appsStable: {
    identifier: 'io.modelcontextprotocol/ui',
    maturity: 'stable',
    protocolEra: '2026-01-26',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-apps',
      revision: '82221c0c8ce7661efa6771c9d461511b1650495f',
      path: 'specification/2026-01-26/apps.mdx',
      sha256: 'ee452a7d1b9b7fb900acfeb4d6932d3963375b0f3f37d196a4b93eb80312af0e',
      packageVersion: '2.0.3',
      packageName: '@modelcontextprotocol/ext-apps'
    }
  },
  appsDraft: {
    identifier: 'io.modelcontextprotocol/ui',
    maturity: 'draft',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-apps',
      revision: '82221c0c8ce7661efa6771c9d461511b1650495f',
      path: 'specification/draft/apps.mdx',
      sha256: '00e97500a71cd46f27a0c661a3c9ee4df60cf64ba7b069e41227ddf8d41b4269',
      packageVersion: '2.0.3',
      packageName: '@modelcontextprotocol/ext-apps'
    }
  },
  skillsStable: {
    identifier: 'io.modelcontextprotocol/skills',
    maturity: 'stable',
    protocolEra: '2026-07-28',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-skills',
      revision: '167da6c0d42c247a8f8470228a10ca711e3f6c45',
      path: 'specification/stable/skills.mdx',
      sha256: 'b8b4c2faf0ef38d72114b8ea2c4e29bbba1d30151b8dc3b476ca31f685de610c'
    }
  },
  agentSkillsFormat: {
    identifier: 'agentskills.io/skill-format',
    maturity: 'stable',
    protocolEra: 'delegated',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/agentskills/agentskills',
      revision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
      path: 'docs/specification.mdx',
      sha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220'
    }
  },
  serverCard: {
    identifier: 'io.modelcontextprotocol/server-card',
    maturity: 'stable',
    protocolEra: 'final',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-server-card',
      revision: '526201bbc80231daa40ffcdecfc9da4e54e5dc93',
      path: 'schema.json',
      sha256: '2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042'
    }
  },
  serverCardFinalSep: {
    identifier: 'io.modelcontextprotocol/server-card',
    maturity: 'stable',
    protocolEra: 'final',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: 'c518f7a927cff918bce35d3522fcdb046d264d7c',
      path: 'seps/2127-mcp-server-cards.md',
      sha256: 'b7691eee6daa21f0b556e48f83b73f9cc8e61e9ea2da17c1aaf3aa169b348461'
    }
  },
  serverCardDiscovery: {
    identifier: 'io.modelcontextprotocol/server-card-discovery',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-server-card',
      revision: '526201bbc80231daa40ffcdecfc9da4e54e5dc93',
      path: 'docs/discovery.md',
      sha256: '633dacfe5bcdbb3ed2f177be7dd7f9943ed2484a5fdd13bd2b742f43a14c2786'
    }
  },
  interceptors: {
    identifier: 'io.modelcontextprotocol/interceptors',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-interceptors',
      revision: 'b60459844cc95f2170297ebe1c84b7de8b752953',
      path: 'docs/sep.md',
      sha256: '1ccbb25046161f10e631ff4fce20742a816dd5fa018e466a7551cb8675200a35'
    }
  },
  variants: {
    identifier: 'io.modelcontextprotocol/server-variants',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '53448f2fab9ac0fddf602db441245625b598ca4e',
      path: 'seps/2053-server-variants.md',
      sha256: 'acb459c128b2b26af772f878919c40d7a7a0c23d364c594c08cf01e733b95d15',
      trackHead: false
    }
  },
  variantsRepository: {
    identifier: 'io.modelcontextprotocol/server-variants-implementation',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-variants',
      revision: 'cfc05d6f5eb8829f9896d44a6d47360bd15c3b5c',
      path: 'README.md',
      sha256: 'dca88077d719d5c8d55fa128234a05d013f9bff3775005bdf2478d2752f57af6'
    }
  },
  toolAnnotations: {
    identifier: 'io.modelcontextprotocol/tool-annotations',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-tool-annotations',
      revision: 'fecace78a9552f70ba735d750fc3c4b190e20429',
      path: 'README.md',
      sha256: '914c302e762a20754ef1bb5a96fd060b01202f8a397815549c92e85ce59406cb'
    }
  },
  triggersEvents: {
    identifier: 'io.modelcontextprotocol/triggers-events',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-triggers-events',
      revision: '6682596d65eec778fe0b8b1f43b4e89d2fe2c546',
      path: 'docs/design-sketch-proposal.md',
      sha256: 'a4ca4ea18b10e3fe53595c73e593a92d3445ae75897fd8ab15e88bf781efeb5a'
    }
  },
  standardWebhooks: {
    identifier: 'standardwebhooks.com/specification',
    maturity: 'stable',
    protocolEra: 'delegated',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/standard-webhooks/standard-webhooks',
      revision: '7537d2a2d3d52d8f2e0ecd12527af4a9307fd81b',
      path: 'spec/standard-webhooks.md',
      sha256: '47cf696ee08a583f6cddf2d02b13e544e1bd28435b8e418870e8b557b1ed4082'
    }
  },
  ianaIpv4SpecialRegistry: {
    identifier: 'iana/ipv4-special-registry',
    maturity: 'stable',
    protocolEra: '2025-10-09',
    availability: 'reviewed',
    source: {
      url: 'https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv',
      path: 'iana-ipv4-special-registry-1.csv',
      sha256: 'e3e39e76d00b1677335db8e9a805c7b9480ea2f4dc9e33f0b93cd3a905128d73',
      trackHead: false
    }
  },
  ianaIpv6SpecialRegistry: {
    identifier: 'iana/ipv6-special-registry',
    maturity: 'stable',
    protocolEra: '2025-10-09',
    availability: 'reviewed',
    source: {
      url: 'https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv',
      path: 'iana-ipv6-special-registry-1.csv',
      sha256: '775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139',
      trackHead: false
    }
  },
  actionMetadata: {
    identifier: 'io.modelcontextprotocol/action-metadata',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-tool-annotations',
      revision: 'fecace78a9552f70ba735d750fc3c4b190e20429',
      path: 'specification/draft/action-metadata.mdx',
      sha256: '985a052969d9b8f67b98e46bb564b62960de47c1e43fdf8f8b9eb157bf50532f'
    }
  },
  trustAnnotations: {
    identifier: 'io.modelcontextprotocol/trust-annotations',
    maturity: 'experimental',
    protocolEra: 'draft',
    availability: 'reviewed',
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-tool-annotations',
      revision: 'fecace78a9552f70ba735d750fc3c4b190e20429',
      path: 'specification/draft/trust-annotations.mdx',
      sha256: '3cc0123157d3ea4489729d8498489e12787297dcfe1f09a5bb02a4a6b0f55b7d'
    }
  },
  filesystems: {
    maturity: 'undefined',
    availability: 'reviewed',
    reason: 'The repository declares an experiment but defines no authoritative MCP wire contract.',
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-filesystems',
      revision: '52b61dc9d63ac697e627eae24b7924de7685db22',
      path: 'README.md',
      sha256: 'feed46abcbaaa9f53c1b70318cb9990343b7410a75dbca2f6c8046de85fb7993'
    }
  }
} as const satisfies Record<string, McpLatestExtensionRecord>

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

export function resolveLatestReviewedVersion<T extends Record<string, unknown>>(
  label: string,
  requested: string | undefined,
  current: keyof T & string,
  records: T
): keyof T & string {
  return resolvePinnedVersion(label, requested, current, records)
}
