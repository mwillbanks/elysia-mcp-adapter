import { describe, expect, test } from 'bun:test'
import {
  isMcpServerSpecificationEligible,
  MCP_SPECIFICATION_INVENTORY,
  MCP_SPECIFICATION_LIFECYCLE
} from '../src/extensions/governance.js'
import { MCP_EXTENSION_LATEST_REVIEWED, MCP_EXTENSION_SUPPORT } from '../src/extensions/manifest.js'

describe('MCP specification authority', () => {
  test('recognizes formal acceptance independently of upstream maturity and implementation', () => {
    const { language, tasks } = MCP_SPECIFICATION_INVENTORY
    expect(language.stage).toBe('draft')
    expect(language.approval).toBe('accepted')
    expect(isMcpServerSpecificationEligible(language)).toBe(true)
    expect(tasks.stage).toBe('beta')
    expect(isMcpServerSpecificationEligible(tasks)).toBe(true)
  })

  test('distinguishes Beta maturity from an approved wire revision', () => {
    const { tasks, skills, serverCard } = MCP_EXTENSION_SUPPORT
    for (const support of [tasks, skills, serverCard]) expect(support.maturity).toBe('beta')
    expect(tasks.versions[tasks.current].status).toBe('stable')
    expect(skills.versions[skills.current].status).toBe('stable')
    expect(serverCard.versions[serverCard.current].status).toBe('stable')
    const latest = MCP_EXTENSION_LATEST_REVIEWED
    for (const record of [
      latest.tasksStable,
      latest.skillsStable,
      latest.serverCard,
      latest.serverCardFinalSep
    ])
      expect(record.maturity).toBe('beta')
  })

  test('requires evidence that a recognized group owns the specific draft', () => {
    const { events, actionMetadata, fileUploads, workloadIdentity } = MCP_SPECIFICATION_INVENTORY
    expect(isMcpServerSpecificationEligible(events)).toBe(true)
    expect(isMcpServerSpecificationEligible(actionMetadata)).toBe(true)
    expect(
      isMcpServerSpecificationEligible({ ...events, group: { charter: events.group.charter } })
    ).toBe(false)
    expect(
      isMcpServerSpecificationEligible({
        ...events,
        group: {
          charter: events.group.charter,
          ownership: { source: { ...events.group.charter.source } }
        }
      })
    ).toBe(false)
    expect(
      isMcpServerSpecificationEligible(MCP_SPECIFICATION_INVENTORY.structuredAuthorizationDenials)
    ).toBe(true)
    expect(isMcpServerSpecificationEligible(fileUploads)).toBe(false)
    expect(isMcpServerSpecificationEligible(workloadIdentity)).toBe(false)
  })

  test('keeps standalone proposals and retired upstream experiments out of new runtime support', () => {
    const { websocket, serverVariants, toolResultVariants } = MCP_SPECIFICATION_INVENTORY
    expect(isMcpServerSpecificationEligible(websocket)).toBe(false)
    expect(isMcpServerSpecificationEligible(toolResultVariants)).toBe(false)
    expect(isMcpServerSpecificationEligible(serverVariants)).toBe(false)
    expect(serverVariants.disposition).toBe('deprecated')
  })
  test('keeps upstream deprecation and adapter retirement schedules separate', () => {
    const { roots, serverVariants } = MCP_SPECIFICATION_LIFECYCLE
    expect(roots.earliestUpstreamRemoval).toBe('2027-07-28')
    expect(roots.migration).toContain('tool arguments')
    expect(serverVariants.adapterRemoval).toBe('later minor')
    expect(serverVariants.revision).toBe(MCP_SPECIFICATION_INVENTORY.serverVariants.source.revision)
  })
})
