import { describe, expect, it } from 'bun:test'
import {
  assertMcpAppsResourceMetadata,
  assertMcpAppsToolMetadata,
  getMcpAppsToolResourceUri,
  getMcpAppsToolVisibility,
  isMcpAppsResourceMimeType,
  isMcpAppsResourceUri,
  MCP_APPS_RESOURCE_MIME_TYPE,
  normalizeMcpAppsResourceContent,
  normalizeMcpAppsToolMetadata,
  resolveMcpAppsProtocolVersion,
  resolveMcpAppsResourceMeta,
  validateMcpAppsResourceContent,
  validateMcpAppsResourceListing
} from '../src/extensions/apps/index.js'

describe('MCP Apps protocol versions', () => {
  it('resolves stable aliases and preserves the draft channel', () => {
    expect(resolveMcpAppsProtocolVersion()).toBe('2026-01-26')
    expect(resolveMcpAppsProtocolVersion('current')).toBe('2026-01-26')
    expect(resolveMcpAppsProtocolVersion('2026-01-26')).toBe('2026-01-26')
    expect(resolveMcpAppsProtocolVersion('draft')).toBe('draft')
    expect(() => resolveMcpAppsProtocolVersion('2025-01-01')).toThrow(
      'Unsupported MCP Apps protocol version'
    )
  })
})

describe('MCP Apps resource validation', () => {
  it('accepts only valid ui:// resource URIs', () => {
    expect(isMcpAppsResourceUri('ui://weather/dashboard.html')).toBe(true)
    expect(isMcpAppsResourceUri('ui:///dashboard.html')).toBe(false)
    expect(isMcpAppsResourceUri('https://example.com/dashboard.html')).toBe(false)
    expect(isMcpAppsResourceUri('ui://')).toBe(false)
  })

  it('requires the exact MCP Apps HTML MIME type', () => {
    expect(isMcpAppsResourceMimeType(MCP_APPS_RESOURCE_MIME_TYPE)).toBe(true)
    expect(isMcpAppsResourceMimeType('text/html')).toBe(false)
    expect(isMcpAppsResourceMimeType('text/html; profile=mcp-app')).toBe(false)
  })

  it('validates listings and content payloads independently', () => {
    expect(
      validateMcpAppsResourceListing({
        uri: 'ui://weather/dashboard.html',
        name: 'Weather dashboard',
        mimeType: MCP_APPS_RESOURCE_MIME_TYPE
      })
    ).toEqual({ valid: true, issues: [] })

    expect(
      validateMcpAppsResourceContent({
        uri: 'ui://weather/dashboard.html',
        mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
        text: '<!doctype html><html></html>'
      })
    ).toEqual({ valid: true, issues: [] })

    const invalid = validateMcpAppsResourceContent({
      uri: 'ui://weather/dashboard.html',
      mimeType: 'text/html',
      text: '<html></html>',
      blob: 'PGh0bWw+PC9odG1sPg=='
    })
    expect(invalid.valid).toBe(false)
    expect(invalid.issues.map(({ path }) => path)).toEqual(['mimeType', 'content'])
  })

  it('normalizes omitted resource MIME types to the protocol MIME type', () => {
    expect(
      normalizeMcpAppsResourceContent({
        uri: 'ui://weather/dashboard.html',
        text: '<!doctype html><html></html>'
      }).mimeType
    ).toBe(MCP_APPS_RESOURCE_MIME_TYPE)
  })
})

describe('MCP Apps metadata', () => {
  it('normalizes nested tool metadata to the legacy key', () => {
    const metadata = normalizeMcpAppsToolMetadata({
      traceId: 'trace-1',
      ui: {
        resourceUri: 'ui://weather/dashboard.html',
        visibility: ['model', 'app']
      }
    })

    expect(metadata).toEqual({
      traceId: 'trace-1',
      ui: {
        resourceUri: 'ui://weather/dashboard.html',
        visibility: ['model', 'app']
      },
      'ui/resourceUri': 'ui://weather/dashboard.html'
    })
  })

  it('normalizes legacy metadata and gives nested metadata precedence', () => {
    expect(
      normalizeMcpAppsToolMetadata({
        'ui/resourceUri': 'ui://legacy/dashboard.html'
      })
    ).toMatchObject({
      ui: { resourceUri: 'ui://legacy/dashboard.html' },
      'ui/resourceUri': 'ui://legacy/dashboard.html'
    })

    const conflicting = {
      ui: { resourceUri: 'ui://current/dashboard.html' },
      'ui/resourceUri': 'ui://legacy/dashboard.html'
    }
    expect(getMcpAppsToolResourceUri(conflicting)).toBe('ui://current/dashboard.html')
    expect(normalizeMcpAppsToolMetadata(conflicting)['ui/resourceUri']).toBe(
      'ui://current/dashboard.html'
    )
  })

  it('defaults visibility and rejects invalid visibility values', () => {
    expect(getMcpAppsToolVisibility({ ui: {} })).toEqual(['model', 'app'])
    expect(getMcpAppsToolVisibility({ ui: { visibility: ['app', 'app'] } })).toEqual(['app'])
    expect(() => getMcpAppsToolVisibility({ ui: { visibility: ['host'] } })).toThrow()
  })

  it('treats resources/read UI metadata as a whole-value override', () => {
    const listing = {
      traceId: 'listing',
      ui: {
        csp: { connectDomains: ['https://listing.example.com'] },
        prefersBorder: true,
        domain: 'https://static.example.com'
      }
    }
    const content = {
      traceId: 'content',
      ui: {
        csp: { resourceDomains: ['https://content.example.com'] },
        prefersBorder: false
      }
    }

    expect(resolveMcpAppsResourceMeta(listing, content)).toEqual({
      csp: { resourceDomains: ['https://content.example.com'] },
      prefersBorder: false
    })
    expect(resolveMcpAppsResourceMeta(listing, undefined)).toBe(listing.ui)
  })

  it('validates stable and draft metadata codecs', () => {
    expect(() =>
      assertMcpAppsToolMetadata(
        {
          ui: {
            resourceUri: 'ui://weather/dashboard.html',
            visibility: ['model']
          }
        },
        '2026-01-26'
      )
    ).not.toThrow()
    expect(() =>
      assertMcpAppsResourceMetadata(
        {
          traceId: 'controlled-generic-metadata',
          ui: {
            csp: { connectDomains: ['https://api.example.com'] },
            permissions: { clipboardWrite: {} },
            domain: 'https://app.example.com',
            prefersBorder: true
          }
        },
        'draft'
      )
    ).not.toThrow()
    expect(() =>
      assertMcpAppsResourceMetadata({ ui: { csp: { connectDomains: [42] } } }, '2026-01-26')
    ).toThrow('array of strings')
    expect(() =>
      assertMcpAppsResourceMetadata({ ui: { permissions: { camera: true } } }, 'draft')
    ).toThrow('empty object')
  })
})
