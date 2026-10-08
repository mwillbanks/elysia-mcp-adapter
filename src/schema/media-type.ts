const TEXTUAL_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-www-form-urlencoded'
])
const SKILL_TEXT_TYPES = new Set(['application/yaml', 'application/x-yaml'])
const BINARY_PREFIXES = ['image/', 'audio/', 'video/', 'application/']

export function isBinaryMimeType(mimeType: string | undefined, skillResource = false): boolean {
  const essence = mimeTypeEssence(mimeType)
  if (!essence || essence.startsWith('text/')) return false
  if (TEXTUAL_APPLICATION_TYPES.has(essence) || textualSuffix(essence)) return false
  if (skillResource && SKILL_TEXT_TYPES.has(essence)) return false
  return (
    essence === 'application/octet-stream' ||
    BINARY_PREFIXES.some((prefix) => essence.startsWith(prefix))
  )
}

export function mimeTypeEssence(mimeType: string | undefined): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function textualSuffix(mimeType: string): boolean {
  return mimeType.endsWith('+json') || mimeType.endsWith('+xml')
}
