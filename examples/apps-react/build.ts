import tailwind from 'bun-plugin-tailwind'

const result = await Bun.build({
  entrypoints: [new URL('./index.html', import.meta.url).pathname],
  outdir: new URL('./dist', import.meta.url).pathname,
  target: 'browser',
  compile: true,
  minify: true,
  sourcemap: 'none',
  plugins: [tailwind]
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

if (result.outputs.length !== 1 || !result.outputs[0]?.path.endsWith('.html')) {
  throw new Error('The React MCP App build must produce exactly one HTML file')
}
