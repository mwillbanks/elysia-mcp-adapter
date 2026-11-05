import type { McpElicitationFormRequest } from '@mwillbanks/elysia-mcp-adapter'

export const approvalKey = 'approval'

export const approvalRequest: McpElicitationFormRequest = {
  method: 'elicitation/create',
  params: {
    message: 'Run the requested task?',
    requestedSchema: {
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved']
    }
  }
}

export function requiresApproval(params: Record<string, unknown>): boolean {
  const args = params.arguments
  if (!args || typeof args !== 'object' || !('body' in args)) return false
  const body = args.body
  return (
    !!body && typeof body === 'object' && 'requireApproval' in body && body.requireApproval === true
  )
}
