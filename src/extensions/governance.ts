import {
  MCP_EXTENSION_LATEST_REVIEWED,
  MCP_EXTENSION_SUPPORT,
  type McpExtensionSource
} from './manifest.js'

const upstream = 'https://github.com/modelcontextprotocol/modelcontextprotocol'
const pull = (number: number): string => `${upstream}/pull/${number}`

export const MCP_SPECIFICATION_GOVERNANCE_SOURCES = {
  structuredAuthorizationDenials: {
    source: {
      repository: 'https://github.com/monmohan/modelcontextprotocol',
      revision: 'c74b0c9321e89a904780d1024d895232fbb03820',
      path: 'seps/2643-structured-authorization-denials.md',
      sha256: '24a1f8bd3424490f16456fcfc1130a2631b6a2d941781ddabaccc2cb12aed20f',
      trackHead: false
    }
  },
  serverCardExtensions: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-server-card',
      revision: '76c9875e65dea657f4e3ec0079e5a0885c801fa8',
      path: 'schema.json',
      sha256: 'f6ec5128a849171edabcdcb5a7d4df2d3ed932d4a15e617aec6be2deb3a694c9',
      trackHead: false
    }
  },
  coreDraft: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'schema/draft/schema.json',
      sha256: 'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203'
    }
  },
  coreSchema: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'schema/2026-07-28/schema.json',
      sha256: 'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203'
    }
  },
  coreTools: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/specification/2026-07-28/server/tools.mdx',
      sha256: '65ae4ba35373803023b5dedbe3b7b5726f84acc8391ad6ef64386b4fbec46abf'
    }
  },
  deprecations: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/specification/2026-07-28/deprecated.mdx',
      sha256: '6ec5fc903d1be37e5ab0afda2acd7765aaf2909b90a2dca405e1aaea8936225b'
    }
  },
  eventsDraft: MCP_EXTENSION_LATEST_REVIEWED.events,
  interceptorsDraft: {
    source: {
      repository: 'https://github.com/Degiorgio/modelcontextprotocol',
      revision: '3a2760642010e30037231ef4d7586750b0654e65',
      path: 'seps/2624-interceptors-for-model-context-protocol.md',
      sha256: 'de2697aef4b8c2cde19f37189fb4c7763da466a3b82165da10c92de7c61cb668',
      trackHead: false
    }
  },
  language: {
    source: {
      repository: 'https://github.com/SamMorrowDrums/modelcontextprotocol',
      revision: '65f75c48df509f94afc8b039ae641a0fa4856a88',
      path: 'seps/2792-i18n-language-negotiation.md',
      sha256: '72c6b9a98e4b8a283d2ce4b136702d72f86c316818bd4683634009f31032be4f',
      trackHead: false
    }
  },
  toolResultVariants: {
    source: {
      repository: 'https://github.com/krubenok/modelcontextprotocol',
      revision: 'e63642f043f2d621d1d11c19f07b1d581518aad0',
      path: 'seps/3279-negotiated-tool-result-variants.md',
      sha256: 'bc25f7f0534997fb1842a59f269aea4c16ace78b0e17f2f7e6ae122cbcc3857a',
      trackHead: false
    }
  },
  apps: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-apps',
      revision: '19256f52cad5517ba8272581ed2e11d6a81273d5',
      path: 'specification/2026-01-26/apps.mdx',
      sha256: 'ee452a7d1b9b7fb900acfeb4d6932d3963375b0f3f37d196a4b93eb80312af0e',
      packageName: '@modelcontextprotocol/ext-apps',
      packageVersion: '2.0.4'
    }
  },
  appsDraft: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-apps',
      revision: '19256f52cad5517ba8272581ed2e11d6a81273d5',
      path: 'specification/draft/apps.mdx',
      sha256: '9a38887ea6aaae24c97200ca41620cf5b0404aa69ed55c5bd95e48b32a84dfa1'
    }
  },
  tasks: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-tasks',
      revision: 'cc9aaac1047a9440b07486e38f37060bbebeef4c',
      path: 'specification/2026-07-28/tasks.md',
      sha256: '5fc22b9b5ff248703927c69855f751a061c2d6170f4dc3923204452f859f91a5',
      packageName: '@modelcontextprotocol/ext-tasks',
      packageVersion: '0.2.3'
    }
  },
  tasksDraft: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-tasks',
      revision: 'cc9aaac1047a9440b07486e38f37060bbebeef4c',
      path: 'specification/draft/tasks.md',
      sha256: '5d1dd2d95c287f7defa97b20823990a3908f9ed93d49977ac8d5de559b6ff49b'
    }
  },
  skills: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-skills',
      revision: '649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a',
      path: 'specification/beta/skills.mdx',
      sha256: '6e33a33762783a02dc4c13c889dda5b8d7c525649012cf77da12d80c04ce6851'
    }
  },
  clientCredentials: MCP_EXTENSION_LATEST_REVIEWED.authClientCredentials,
  enterpriseAuth: MCP_EXTENSION_LATEST_REVIEWED.authEnterprise,
  clientCredentialsDraftHistorical: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/ext-auth',
      revision: 'fb374c7db2b34f18ca9183882e0beecdf661892b',
      path: 'specification/draft/oauth-client-credentials.mdx',
      sha256: '5db1ffb20f0f33ddbebd6e9747be20c1be3a395a1bd1faad3719334c35a70d3f',
      trackHead: false
    }
  },
  interceptorsRepo: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-interceptors',
      revision: '07c89a24879eb2231e2afb72942643ebc8dfe485',
      path: 'docs/sep.md',
      sha256: '0f37696aaa74f269aa5cdb1e1048fa243d9d5c1cf5c400490d92606817af74c2'
    }
  },
  filesystems: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-filesystems',
      revision: '6f9daa1706766685542c4d26a00027992d143f68',
      path: 'README.md',
      sha256: 'f36dc4ebd0449d52e290ed71daa8b4b4861c80c34da08301c7d933f7a001180a'
    }
  },
  catalog: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/extensions/overview.mdx',
      sha256: '99b5666cff4f4c265daef154fdb632610c8811fdd6f2753282c09fbb8e283831'
    }
  },
  governance: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/working-interest-groups.mdx',
      sha256: '62b4e174778adeddf034bf2ab3b606f5ffa500189ae5325fbf8a6418c335f8ee'
    }
  },
  policy: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/feature-lifecycle.mdx',
      sha256: 'b4f7436905c6162801f19565518342238bd76c1e7d23ade6f1fae24c22c3ec7c'
    }
  },
  eventsCharter: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/working-groups/tasks-events.mdx',
      sha256: 'c014818f1a4cf76d805d8563b9f34ea0ef0c1c3a502853ad33923e45cc968722'
    }
  },
  interceptorsCharter: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/working-groups/interceptors.mdx',
      sha256: '82efd5164f6416b2f953c29eb0c54a21d811d21e5a5203eb402bce30806fdda8'
    }
  },
  annotationsCharter: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/interest-groups/tool-annotations.mdx',
      sha256: '6ab9edc31f372f68723b4580e74184d0377945632ea754398361839b79aea96d'
    }
  },
  uploadsCharter: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/working-groups/file-uploads.mdx',
      sha256: '594bfbff35d1683b7663eeebe132863bb513949ccd829cbfd1b3098704aefdf6'
    }
  },
  filesystemsCharter: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/working-groups/filesystems.mdx',
      sha256: '52b39e09cfb325a7ba7b21da7ffd37e9658c2bf551559ae4d4db4e2313072362'
    }
  },
  appsCharter: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/working-groups/apps.mdx',
      sha256: '849b557a8f87b90f2cda2f8d534087275a3fb457abccd197264662b56e33d1b0'
    }
  },
  tasksSep: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'seps/2663-tasks-extension.md',
      sha256: '2bd75e527a0796ffbc07ed34c47307a43c78de1e3001eada52e601051c09a385'
    }
  },
  skillsSep: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'seps/2640-skills-extension.md',
      sha256: '5deaf5d6c4562b7be722c662bb543dad28a16fc41c5c70af4e6b9e64147bd29b'
    }
  },
  serverCardSep: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'seps/2127-mcp-server-cards.md',
      sha256: 'b7691eee6daa21f0b556e48f83b73f9cc8e61e9ea2da17c1aaf3aa169b348461'
    }
  },
  extensionLifecycle: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'seps/3392-extension-lifecycle.md',
      sha256: 'e4ed07892365a2887b51e515de4b5207f47a746f07b0d9308bbef516ca03bb62'
    }
  },
  annotationsDisposition: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/experimental-ext-tool-annotations',
      revision: 'fecace78a9552f70ba735d750fc3c4b190e20429',
      path: 'docs/sep-disposition.md',
      sha256: '6ff8f68b27dd020ebee2a4795d46034c8bd13469e49f485268fb77c37df870ff'
    }
  },
  oldEvents: MCP_EXTENSION_LATEST_REVIEWED.triggersEvents,
  coreMaintainers: {
    source: {
      repository: upstream,
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/governance.mdx',
      sha256: '628b17a407982570f978e5d16492345c6e3d1059aca7fc6baed79f797cc1a856'
    }
  },
  authorizationDraft: { source: MCP_EXTENSION_SUPPORT.auth.versions.draft.source },
  authCharter: {
    source: {
      repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
      revision: '3c4d91b7e832d9b74338d56eed03403ccc662123',
      path: 'docs/community/interest-groups/auth.mdx',
      sha256: 'e264fee318102ce6a99ab478391e2555707e5ad10f7634e0015f04ca706ba0b3'
    }
  },
  dpop: {
    source: {
      repository: 'https://github.com/PieterKas/modelcontextprotocol',
      revision: '2489116e1bf604005e12fc3df1283abefada7a84',
      path: 'seps/1932-dpop-extension.md',
      sha256: 'f4848780e1c44a33c825c6d47c61a61c7b520e46108e83e0dd5824db63aaf4b7',
      trackHead: false
    }
  },
  wif: {
    source: {
      repository: 'https://github.com/PieterKas/modelcontextprotocol',
      revision: 'dc82998fa3143c74fefc8d0e9455fd60fe3a7a98',
      path: 'seps/1933-workload-identity-federation.md',
      sha256: '90f0ad5fd97cd7b3ed0c9375e01dd6fea836610b865f320d387acd09645a68b7',
      trackHead: false
    }
  }
} as const

const sources = MCP_SPECIFICATION_GOVERNANCE_SOURCES
const reviewed = MCP_EXTENSION_LATEST_REVIEWED

interface GroupAuthority {
  charter: { source: McpExtensionSource }
  ownership?: { source: McpExtensionSource } | { url: string }
}

interface McpSpecificationRecord {
  stage: 'stable' | 'beta' | 'draft' | 'experimental' | 'proposal'
  approval: 'released' | 'accepted' | 'unapproved'
  scope: 'server' | 'external' | 'undefined'
  disposition: 'implemented' | 'planned' | 'inventory' | 'deprecated'
  source?: McpExtensionSource
  proposal?: string
  group?: GroupAuthority
  reason?: string
}

const eventsGroup = { charter: sources.eventsCharter, ownership: sources.eventsDraft }
const interceptorGroup = {
  charter: sources.interceptorsCharter,
  ownership: sources.interceptorsRepo
}
const annotationsGroup = {
  charter: sources.annotationsCharter,
  ownership: sources.annotationsDisposition
}
const authGroup = {
  charter: sources.authCharter,
  ownership: { url: `${upstream}/discussions/2117` }
}

/** Approval describes the recorded wire revision; disposition describes the adapter. */
export const MCP_SPECIFICATION_INVENTORY = {
  core: {
    stage: 'stable',
    approval: 'released',
    scope: 'server',
    disposition: 'implemented',
    source: sources.coreSchema.source
  },
  coreDraft: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'inventory',
    source: sources.coreDraft.source,
    reason: 'The draft schema matches the released schema byte for byte.'
  },
  apps: {
    stage: 'stable',
    approval: 'released',
    scope: 'server',
    disposition: 'implemented',
    source: sources.apps.source
  },
  appsDraft: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: sources.appsDraft.source,
    group: { charter: sources.appsCharter, ownership: sources.appsDraft },
    reason:
      'The existing server wire profile covers the draft. The changes concern host framing and view SDK interoperability.'
  },
  tasks: {
    stage: 'beta',
    approval: 'accepted',
    scope: 'server',
    disposition: 'implemented',
    source: sources.tasks.source,
    proposal: pull(2663)
  },
  tasksDraft: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: MCP_EXTENSION_SUPPORT.tasks.versions[MCP_EXTENSION_SUPPORT.tasks.draft].source,
    group: { charter: sources.eventsCharter, ownership: sources.tasksDraft }
  },
  skills: {
    stage: 'beta',
    approval: 'accepted',
    scope: 'server',
    disposition: 'implemented',
    source: MCP_EXTENSION_SUPPORT.skills.versions[MCP_EXTENSION_SUPPORT.skills.current].source,
    proposal: pull(2640)
  },
  skillsHistorical: {
    stage: 'beta',
    approval: 'accepted',
    scope: 'server',
    disposition: 'implemented',
    source:
      MCP_EXTENSION_SUPPORT.skills.versions['167da6c0d42c247a8f8470228a10ca711e3f6c45'].source,
    proposal: pull(2640)
  },
  serverCard: {
    stage: 'beta',
    approval: 'accepted',
    scope: 'server',
    disposition: 'implemented',
    source: reviewed.serverCard.source,
    proposal: pull(2127)
  },
  serverCardExtensions: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: sources.serverCardExtensions.source,
    proposal: 'https://github.com/modelcontextprotocol/ext-server-card/pull/55',
    group: {
      charter: sources.eventsCharter,
      ownership: { url: 'https://github.com/modelcontextprotocol/ext-server-card/pull/55' }
    },
    reason:
      'The proposal records the Tasks and Events Working Group agreement on metadata placement.'
  },
  authorizationDraft: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: sources.authorizationDraft.source,
    group: { charter: sources.coreMaintainers, ownership: sources.authorizationDraft },
    reason:
      'The MCP Core Maintainers publish the core authorization draft in the official specification.'
  },
  clientCredentials: {
    stage: 'stable',
    approval: 'released',
    scope: 'server',
    disposition: 'implemented',
    source: sources.clientCredentials.source
  },
  clientCredentialsDraftHistorical: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'inventory',
    source: sources.clientCredentialsDraftHistorical.source,
    reason: 'The approved 2026-07-28 revision supersedes the former draft selector.'
  },
  enterpriseAuth: {
    stage: 'stable',
    approval: 'released',
    scope: 'server',
    disposition: 'implemented',
    source: sources.enterpriseAuth.source
  },
  events: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: sources.eventsDraft.source,
    proposal: pull(3415),
    group: eventsGroup
  },
  interceptors: {
    stage: 'experimental',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: sources.interceptorsRepo.source,
    proposal: pull(2624),
    group: interceptorGroup
  },
  actionMetadata: {
    stage: 'experimental',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: reviewed.actionMetadata.source,
    group: annotationsGroup
  },
  trustAnnotations: {
    stage: 'experimental',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: reviewed.trustAnnotations.source,
    group: annotationsGroup
  },
  language: {
    stage: 'draft',
    approval: 'accepted',
    scope: 'server',
    disposition: 'implemented',
    source: sources.language.source,
    proposal: pull(2792)
  },
  dpop: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: sources.dpop.source,
    proposal: pull(1932),
    group: authGroup
  },
  structuredAuthorizationDenials: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'implemented',
    source: sources.structuredAuthorizationDenials.source,
    proposal: pull(2643),
    group: { charter: sources.authCharter, ownership: sources.structuredAuthorizationDenials }
  },
  workloadIdentity: {
    stage: 'draft',
    approval: 'unapproved',
    scope: 'external',
    disposition: 'inventory',
    source: sources.wif.source,
    proposal: pull(1933),
    group: authGroup,
    reason: 'The profile adds responsibilities for clients and OAuth authorization servers.'
  },
  websocket: {
    stage: 'proposal',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'inventory',
    proposal: pull(1287),
    reason: 'The proposal closed unmerged and no proposal-specific group ownership was found.'
  },
  serverVariants: {
    stage: 'experimental',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'deprecated',
    source: reviewed.variants.source,
    proposal: pull(2053),
    reason: 'The proposal closed unmerged and the prototype describes it as unaccepted.'
  },
  toolResultVariants: {
    stage: 'proposal',
    approval: 'unapproved',
    scope: 'server',
    disposition: 'inventory',
    source: sources.toolResultVariants.source,
    proposal: pull(3279),
    reason: 'This is a separate proposal seeking a sponsor.'
  },
  fileUploads: {
    stage: 'experimental',
    approval: 'unapproved',
    scope: 'undefined',
    disposition: 'inventory',
    group: { charter: sources.uploadsCharter },
    reason: 'The group has not published an implementable wire contract.'
  },
  filesystems: {
    stage: 'experimental',
    approval: 'unapproved',
    scope: 'undefined',
    disposition: 'inventory',
    group: { charter: sources.filesystemsCharter },
    reason: 'The group has not published an implementable wire contract.'
  }
} as const satisfies Record<string, McpSpecificationRecord>

export function isMcpServerSpecificationEligible(record: McpSpecificationRecord): boolean {
  if (record.scope !== 'server' || !record.source?.revision) return false
  return record.approval !== 'unapproved' || hasIndependentOwnershipEvidence(record.group)
}

function hasIndependentOwnershipEvidence(group: GroupAuthority | undefined): boolean {
  if (!group?.ownership) return false
  if ('url' in group.ownership) return true
  const charter = group.charter.source
  const evidence = group.ownership.source
  return evidence.repository !== charter.repository || evidence.path !== charter.path
}

const deprecatedCore = 'https://modelcontextprotocol.io/specification/2026-07-28/deprecated'
const earliestCoreRemoval = '2027-07-28'

export const MCP_SPECIFICATION_PROPOSAL_HEADS = [
  {
    repository: 'modelcontextprotocol/modelcontextprotocol',
    number: 2792,
    pin: sources.language.source,
    accepted: true
  },
  {
    repository: 'modelcontextprotocol/modelcontextprotocol',
    number: 3415,
    pin: sources.eventsDraft.source,
    accepted: false
  },
  {
    repository: 'modelcontextprotocol/modelcontextprotocol',
    number: 2624,
    pin: sources.interceptorsDraft.source,
    accepted: false
  },
  {
    repository: 'modelcontextprotocol/modelcontextprotocol',
    number: 1932,
    pin: sources.dpop.source,
    accepted: false
  },
  {
    repository: 'modelcontextprotocol/modelcontextprotocol',
    number: 2643,
    pin: sources.structuredAuthorizationDenials.source,
    accepted: false
  },
  {
    repository: 'modelcontextprotocol/modelcontextprotocol',
    number: 1933,
    pin: sources.wif.source,
    accepted: false
  },
  {
    repository: 'modelcontextprotocol/ext-server-card',
    number: 55,
    pin: sources.serverCardExtensions.source,
    accepted: false
  }
] as const

/** Runtime notices use only these catalog values, never request fields. */
export const MCP_SPECIFICATION_LIFECYCLE = {
  serverVariants: {
    featureId: 'io.modelcontextprotocol/server-variants',
    revision: reviewed.variants.source.revision,
    sourceUrl: pull(2053),
    migration: 'Publish distinct MCP endpoints for different tool sets.',
    adapterRemoval: 'later minor'
  },
  roots: {
    featureId: 'io.modelcontextprotocol/core-roots',
    revision: '2026-07-28',
    sourceUrl: deprecatedCore,
    migration: 'Pass directories through tool arguments, resource URIs, or server configuration.',
    earliestUpstreamRemoval: earliestCoreRemoval
  },
  sampling: {
    featureId: 'io.modelcontextprotocol/core-sampling',
    revision: '2026-07-28',
    sourceUrl: deprecatedCore,
    migration: 'Call the model provider API from the application.',
    earliestUpstreamRemoval: earliestCoreRemoval
  },
  logging: {
    featureId: 'io.modelcontextprotocol/core-logging',
    revision: '2026-07-28',
    sourceUrl: deprecatedCore,
    migration: 'Use OpenTelemetry for server observability.',
    earliestUpstreamRemoval: earliestCoreRemoval
  },
  dynamicClientRegistration: {
    featureId: 'dynamic-client-registration',
    revision: '2026-07-28',
    sourceUrl: deprecatedCore,
    migration: 'Use Client ID Metadata Documents.',
    earliestUpstreamRemoval: earliestCoreRemoval
  },
  samplingIncludeContext: {
    featureId: 'sampling-include-context',
    revision: '2025-11-25',
    sourceUrl: deprecatedCore,
    migration: 'Omit includeContext or set it to none.',
    earliestUpstreamRemoval: earliestCoreRemoval
  },
  legacyHttpSse: {
    featureId: 'http-with-sse',
    revision: '2025-03-26',
    sourceUrl: deprecatedCore,
    migration: 'Use Streamable HTTP.',
    earliestUpstreamRemoval: 'Three months after SEP-2596 reached Final.'
  }
} as const
