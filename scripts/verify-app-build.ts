const target = Bun.argv[2]
if (!target) throw new Error('Expected a generated HTML path')

const file = Bun.file(target)
if (!(await file.exists())) throw new Error(`Missing generated HTML: ${target}`)
const html = await file.text()

if (!/^<!doctype html>/i.test(html.trim())) throw new Error('Output is not an HTML5 document')
const markupOnly = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '')
if (/<(?:script|link|img|source)\b[^>]+(?:src|href)=["'](?!data:|#)/iu.test(markupOnly)) {
  throw new Error('Generated HTML contains an unresolved or external asset reference')
}
if (/sourceMappingURL|vite\/client|@vite|\/Volumes\/|\/Users\//u.test(html)) {
  throw new Error('Generated HTML contains a source map, Vite runtime, or local filesystem path')
}
if (
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AWS_SECRET_ACCESS_KEY|authorization:\s*bearer/iu.test(
    html
  )
) {
  throw new Error('Generated HTML contains credential-like material')
}

const slash = target.lastIndexOf('/')
const directory = slash === -1 ? '.' : target.slice(0, slash)
const siblingHtml = await Array.fromAsync(new Bun.Glob('*.html').scan({ cwd: directory }))
if (siblingHtml.length !== 1)
  throw new Error('The build directory must contain exactly one HTML file')
