import { describe, expect, test } from 'bun:test'
import {
  MCP_EXTENSION_LATEST_REVIEWED,
  MCP_EXTENSION_SUPPORT,
  type McpLatestExtensionRecord,
  resolveLatestReviewedVersion
} from '../src/extensions/manifest.js'

const expectedLatestKeys = [
  'coreTypeScriptSchema',
  'coreDraftTypeScriptSchema',
  'coreSchema',
  'coreTools',
  'coreMrtr',
  'coreAuthorization',
  'coreDraftSchema',
  'coreBasic',
  'coreVersioning',
  'coreStreamableHttp',
  'coreCancellation',
  'coreProgress',
  'coreSubscriptions',
  'coreDiscover',
  'coreResources',
  'corePrompts',
  'coreCompletion',
  'corePagination',
  'coreCaching',
  'coreLogging',
  'coreRoots',
  'coreSampling',
  'coreElicitation',
  'tasksStable',
  'tasksDraft',
  'authEnterprise',
  'authClientCredentials',
  'appsStable',
  'appsDraft',
  'skillsStable',
  'agentSkillsFormat',
  'serverCard',
  'serverCardFinalSep',
  'serverCardDiscovery',
  'interceptors',
  'variants',
  'variantsRepository',
  'toolAnnotations',
  'triggersEvents',
  'standardWebhooks',
  'ianaIpv4SpecialRegistry',
  'ianaIpv6SpecialRegistry',
  'actionMetadata',
  'trustAnnotations',
  'filesystems'
] as const

const expectedDigests: Record<string, string> = {
  coreTypeScriptSchema: '742750af0bb8c716e7030c4977c992b55d1adc4407e9e66997db5846baedc2cd',
  coreDraftTypeScriptSchema: 'b2d3a00d4094e413a48628560fec60652169a3d2b427e8c629238e13f987723f',
  coreSchema: 'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203',
  coreTools: 'ed550806a58eb7744b858fb9f26001aa5e55dac9e2babe88317cc81d9d4c490d',
  coreMrtr: 'a8671eb2a0d292c0dcbae19666ff4fc3d97f294ce8107e9f38259cc5a02a066b',
  coreAuthorization: '99e7eeaecad5381649e6dca98cb5b47f314bdda9f1d8cd989299e5fe143a913e',
  coreDraftSchema: 'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203',
  coreBasic: '03586b10e3214c55478293f1199fffb0bbf95bbef5df3d6a8378e860697bd63f',
  coreVersioning: 'bc02f271700bdecd88034f2d7801eb09110a71d65876487378d94e48dfeb90dc',
  coreStreamableHttp: '22574bf11e004068493787203ce92be1162107cad717bcb805a15780d4fa69c9',
  coreCancellation: '396030784a4af9b734a1c8d4faed13b31077e4a3a1f03c9c1f2048ec52794ba4',
  coreProgress: '9f55aca08920c633f3a2a35e0c77533db08d3fd19ced43918ea7c57aa5f85409',
  coreSubscriptions: '8333cbc3280cad293e96b4a20c3200face8e185ebf58f1c4a51c35bb96654abd',
  coreDiscover: '3fe1f5b5f1528014216b1e49cc3363b3c689c36bcb80a6957ddca6a04cea409c',
  coreResources: '10538119019af5f49a2fbc55d5818725175863115dfb273e79ed7f65a18aaf0c',
  corePrompts: '85e550635bbbbaa90dff8738f98808c62987e8cfce1d75305b55ca43f3c546de',
  coreCompletion: '1965c563aadb99e141131444caa81ff1860ed82bab314b286c40a0f0ba839f99',
  corePagination: 'c4c7b674ae9ce16c012b5da35559d35768f6b7a508ceb5d2d71393a9f46afd2b',
  coreCaching: 'ca416e94b40c067de638bb101541969f2b956b33e9695761032ddc06245d514d',
  coreLogging: '4e77ec3257e07ad69bfd6ed902771f14d6498b60fe6c9c325b8ff4bfc35647a6',
  coreRoots: '016aea34d76ccce86a82509dbf2699833bb8547bde5b3f4a8eb086dfd26a9ba2',
  coreSampling: '32fe2bb69f5a7caa85a6b9501f465cb1fb888d0c669cd13b23a071071a029df1',
  coreElicitation: '74351d1081681695536e59a55588a67ed66a76db6057846c263ce2f465fab4c2',
  tasksStable: 'ef2860ae4418d02f3b2bfd54fcd88b03a3c2c3aa6724d282cd4ca3a3699a2e27',
  tasksDraft: '7fd574093a5c4e29da19a0d7683693af7b93a276f3ce37343664c9e12f4d039a',
  authEnterprise: 'df4fe01daec0eac6069e17a293d4ed7e197ab20463038d806f71e63b22fd8986',
  authClientCredentials: '5db1ffb20f0f33ddbebd6e9747be20c1be3a395a1bd1faad3719334c35a70d3f',
  appsStable: 'ee452a7d1b9b7fb900acfeb4d6932d3963375b0f3f37d196a4b93eb80312af0e',
  appsDraft: '00e97500a71cd46f27a0c661a3c9ee4df60cf64ba7b069e41227ddf8d41b4269',
  skillsStable: 'b8b4c2faf0ef38d72114b8ea2c4e29bbba1d30151b8dc3b476ca31f685de610c',
  agentSkillsFormat: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
  serverCard: '2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042',
  serverCardFinalSep: 'b7691eee6daa21f0b556e48f83b73f9cc8e61e9ea2da17c1aaf3aa169b348461',
  serverCardDiscovery: '633dacfe5bcdbb3ed2f177be7dd7f9943ed2484a5fdd13bd2b742f43a14c2786',
  interceptors: '1ccbb25046161f10e631ff4fce20742a816dd5fa018e466a7551cb8675200a35',
  variants: 'acb459c128b2b26af772f878919c40d7a7a0c23d364c594c08cf01e733b95d15',
  variantsRepository: 'dca88077d719d5c8d55fa128234a05d013f9bff3775005bdf2478d2752f57af6',
  toolAnnotations: '914c302e762a20754ef1bb5a96fd060b01202f8a397815549c92e85ce59406cb',
  triggersEvents: 'a4ca4ea18b10e3fe53595c73e593a92d3445ae75897fd8ab15e88bf781efeb5a',
  standardWebhooks: '47cf696ee08a583f6cddf2d02b13e544e1bd28435b8e418870e8b557b1ed4082',
  ianaIpv4SpecialRegistry: 'e3e39e76d00b1677335db8e9a805c7b9480ea2f4dc9e33f0b93cd3a905128d73',
  ianaIpv6SpecialRegistry: '775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139',
  actionMetadata: '985a052969d9b8f67b98e46bb564b62960de47c1e43fdf8f8b9eb157bf50532f',
  trustAnnotations: '3cc0123157d3ea4489729d8498489e12787297dcfe1f09a5bb02a4a6b0f55b7d',
  filesystems: 'feed46abcbaaa9f53c1b70318cb9990343b7410a75dbca2f6c8046de85fb7993'
}

function assertContractIdentity(record: McpLatestExtensionRecord): void {
  if (record.maturity === 'undefined') {
    expect(record).not.toHaveProperty('identifier')
    expect(record).not.toHaveProperty('protocolEra')
    return
  }
  expect(record.identifier?.length ?? 0).toBeGreaterThan(0)
  expect(record.protocolEra?.length ?? 0).toBeGreaterThan(0)
}

function assertSourceIntegrity(key: string, record: McpLatestExtensionRecord): void {
  if (record.availability !== 'reviewed') {
    expect(record.source).toBeUndefined()
    expect(record.reason).toMatch(/authoritative MCP specification/u)
    return
  }
  expect(record.source).toBeDefined()
  const source = record.source
  if (!source) throw new Error(`Reviewed source is missing for ${key}`)
  expect(source.url ?? source.repository).toMatch(/^https:\/\//u)
  if (source.repository) expect(source.revision).toMatch(/^[0-9a-z._-]+$/iu)
  expect(source.path.length).toBeGreaterThan(0)
  expect(source.sha256).toMatch(/^[0-9a-f]{64}$/u)
  const expectedDigest = expectedDigests[key]
  if (!expectedDigest) throw new Error(`Expected digest is missing for ${key}`)
  expect(source.sha256).toBe(expectedDigest)
}

describe('upstream extension inventory', () => {
  test('preserves the established support aliases and immutable pins', () => {
    expect(MCP_EXTENSION_SUPPORT.protocol.current).toBe('2026-07-28')
    expect(MCP_EXTENSION_SUPPORT.protocol.versions['2026-07-28'].source.revision).toBe(
      '5f5440bb26a62e2cf3440b92da5a667efa03b267'
    )
    expect(MCP_EXTENSION_SUPPORT.apps.versions['2026-01-26'].source.packageVersion).toBe('1.7.5')
    expect(MCP_EXTENSION_SUPPORT.serverCard.maturity).toBe('stable')
    expect(
      MCP_EXTENSION_SUPPORT.serverCard.versions['526201bbc80231daa40ffcdecfc9da4e54e5dc93'].status
    ).toBe('experimental')
  })

  test('covers every reviewed extension and records immutable source integrity', () => {
    expect(Object.keys(MCP_EXTENSION_LATEST_REVIEWED).sort()).toEqual(
      [...expectedLatestKeys].sort()
    )
    expect(Object.keys(expectedDigests).sort()).toEqual([...expectedLatestKeys].sort())

    for (const [key, record] of Object.entries(MCP_EXTENSION_LATEST_REVIEWED)) {
      assertContractIdentity(record)
      assertSourceIntegrity(key, record)
    }
  })

  test('resolves latest-reviewed aliases without changing support aliases', () => {
    expect(
      resolveLatestReviewedVersion(
        'extension',
        undefined,
        'coreSchema',
        MCP_EXTENSION_LATEST_REVIEWED
      )
    ).toBe('coreSchema')
    expect(
      resolveLatestReviewedVersion(
        'extension',
        'skillsStable',
        'coreSchema',
        MCP_EXTENSION_LATEST_REVIEWED
      )
    ).toBe('skillsStable')
    expect(() =>
      resolveLatestReviewedVersion(
        'extension',
        'missing',
        'coreSchema',
        MCP_EXTENSION_LATEST_REVIEWED
      )
    ).toThrow('Unsupported extension specification version')
  })

  test('records current upstream review state without inventing extension contracts', () => {
    expect(MCP_EXTENSION_LATEST_REVIEWED.coreSchema.source.revision).toBe(
      'c518f7a927cff918bce35d3522fcdb046d264d7c'
    )
    expect(MCP_EXTENSION_LATEST_REVIEWED.tasksStable.source.revision).toBe(
      '93a4915aadf714f87ece5cd40c317bce24779cf5'
    )
    expect(MCP_EXTENSION_LATEST_REVIEWED.serverCard.maturity).toBe('stable')
    expect(MCP_EXTENSION_LATEST_REVIEWED.filesystems).toMatchObject({
      maturity: 'undefined',
      availability: 'reviewed'
    })
    expect(MCP_EXTENSION_LATEST_REVIEWED.filesystems).not.toHaveProperty('identifier')
    expect(MCP_EXTENSION_LATEST_REVIEWED.filesystems).not.toHaveProperty('protocolEra')
  })
})
