import { MCP_EVENTS_REVISION, mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'
import { InMemoryEventHistory } from './event-source.js'

const buildHistory = new InMemoryEventHistory(20)
export function publishBuildUpdate(project: string, sequence: number) {
  return buildHistory.publish('com.example.build.changed', { sequence }, project)
}

function createEventApp() {
  return new Elysia()
    .use(
      mcp({
        allowedRoutes: [],
        transport: {
          protocolVersions: ['2025-11-25'],
          enableGetSse: true,
          enableDeleteSession: true
        },
        extensions: {
          events: {
            version: MCP_EVENTS_REVISION,
            cursor: {
              signingKey: 'example-events-cursor-signing-key-at-least-32-bytes',
              ttlMs: 60_000
            },
            heartbeatMs: 25,
            pollIntervalMs: 5,
            maxEvents: 10,
            maxAgeMs: 60_000
          }
        }
      })
    )
    .mcpEvent(
      {
        name: 'com.example.build.changed',
        description: 'A build changed state',
        delivery: ['poll', 'push'],
        inputSchema: {
          type: 'object',
          properties: { project: { type: 'string' } },
          required: ['project'],
          additionalProperties: false
        },
        payloadSchema: {
          type: 'object',
          properties: { sequence: { type: 'number' } },
          required: ['sequence'],
          additionalProperties: false
        }
      },
      buildHistory.handler(5)
    )
}
export const app = createEventApp()
