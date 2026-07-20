export interface UriTemplateMatch {
  ok: boolean
  variables: Record<string, string>
}

export function isUriTemplate(value: string): boolean {
  return /\{[^}]+\}/.test(value)
}

export function matchUriTemplate(template: string, uri: string): UriTemplateMatch {
  const names: string[] = []
  const pattern = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    names.push(name)
    return '([^/?#]+)'
  })

  const match = new RegExp(`^${escapeTemplateRegex(pattern)}$`).exec(uri)
  if (!match) return { ok: false, variables: {} }

  const variables: Record<string, string> = {}
  names.forEach((name, index) => {
    variables[name] = decodeURIComponent(match[index + 1] ?? '')
  })

  return { ok: true, variables }
}

export function templateName(template: string): string {
  return template.replace(/\{([^}]+)\}/g, 'by_$1')
}

function escapeTemplateRegex(patternWithGroups: string): string {
  return patternWithGroups
    .split('([^/?#]+)')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('([^/?#]+)')
}
