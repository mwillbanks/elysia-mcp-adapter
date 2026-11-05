import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const adapter = '@mwillbanks/elysia-mcp-adapter'
const skill = 'elysia-mcp-adapter'
const allowed = `${adapter}#${skill}`
const sentinel = 'intent-fixture-allowed#sample'
const excluded = 'intent-fixture-excluded#sample'
const unlisted = 'intent-fixture-unlisted#sample'
const skillDirectory = `skills/${skill}`
const referenceFiles = [
  'references/extensions.md',
  'references/route-exposure.md',
  'references/standalone-primitives.md',
  'references/transport-authorization.md'
]
const expectedSkillFiles = ['SKILL.md', ...referenceFiles]
const intentCli = join(root, 'node_modules/@tanstack/intent/dist/cli.mjs')

export async function verifyPackedIntent(archive: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'elysia-intent-consumer-'))
  try {
    await verifyArchive(archive, directory)
    const marker = await installConsumer(archive, directory)
    await verifyCatalog(directory)
    await verifyLoad(directory)
    await assertRefused(directory, excluded, 'is excluded by Intent configuration')
    await assertRefused(directory, unlisted, 'is not listed in intent.skills')
    assert.equal(existsSync(marker), false, 'Intent executed code from a scanned dependency')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function verifyArchive(archive: string, directory: string): Promise<void> {
  const listing = await run(['tar', '-tzf', archive], directory)
  const members = listing.trimEnd().split('\n')
  const prefix = `package/${skillDirectory}/`
  const files = members
    .filter((member) => member.startsWith(prefix) && !member.endsWith('/'))
    .map((member) => member.slice(prefix.length))
    .sort()
  assert.deepEqual(files, expectedSkillFiles, 'Published skill files differ from the expected set')
  assert.doesNotMatch(
    listing,
    /\/(?:_artifacts|\.intent)(?:\/|$)/m,
    'Published maintainer material'
  )
}

async function installConsumer(archive: string, directory: string): Promise<string> {
  const manifest = {
    private: true,
    dependencies: { [adapter]: archive },
    intent: { skills: [allowed, sentinel, excluded], exclude: [excluded] }
  }
  const manifestPath = join(directory, 'package.json')
  await Bun.write(manifestPath, JSON.stringify(manifest))
  await run([process.execPath, 'install', '--ignore-scripts'], directory)

  // Emulate additional installed dependencies without running their install hooks.
  const marker = join(directory, 'package-code-executed')
  const fixturePackages = [
    'intent-fixture-allowed',
    'intent-fixture-excluded',
    'intent-fixture-unlisted'
  ]
  await Promise.all(fixturePackages.map((name) => writeSentinelPackage(directory, name, marker)))
  const fixtureDependencies = Object.fromEntries(fixturePackages.map((name) => [name, '1.0.0']))
  await Bun.write(
    manifestPath,
    JSON.stringify({
      ...manifest,
      dependencies: { ...manifest.dependencies, ...fixtureDependencies }
    })
  )
  return marker
}

async function verifyCatalog(directory: string): Promise<void> {
  const catalog = JSON.parse(await run(['node', intentCli, 'list', '--json'], directory)) as {
    skills: { use: string; packageSource: string }[]
  }
  const available = catalog.skills.map(({ use, packageSource }) => [use, packageSource]).sort()
  const expected = [allowed, sentinel].sort().map((reference) => [reference, 'local'])
  assert.deepEqual(available, expected, 'Intent listed unexpected skills')
}

async function verifyLoad(directory: string): Promise<void> {
  const loaded = JSON.parse(
    await run(['node', intentCli, 'load', allowed, '--json'], directory)
  ) as { package: string; skill: string; source: string; content: string }
  assert.deepEqual(
    [loaded.package, loaded.skill, loaded.source],
    [adapter, skill, 'local'],
    'Intent returned an unexpected skill identity'
  )
  const expectedContent = await expectedLoadedSkill(directory)
  assert.ok(loaded.content === expectedContent, 'Intent returned unexpected skill content')

  const sentinelContent = await run(['node', intentCli, 'load', sentinel], directory)
  assert.match(sentinelContent, /^# Fixture$/m, 'Intent did not load the sentinel skill')
}

async function expectedLoadedSkill(directory: string): Promise<string> {
  const cwd = realpathSync(directory)
  const skillRoot = realpathSync(join(cwd, 'node_modules', adapter, skillDirectory))
  let content = await Bun.file(join(skillRoot, 'SKILL.md')).text()
  for (const reference of referenceFiles) {
    const target = join(skillRoot, reference)
    assert.ok(await Bun.file(target).text(), `Packaged skill reference is empty: ${reference}`)
    const link = `](${reference})`
    assert.ok(content.includes(link), `Packaged skill is missing a reference: ${reference}`)
    // Intent keeps links relative to cwd unless the package resolves outside it.
    const local = relative(cwd, target)
    const destination = local.startsWith('..') ? target : local
    content = content.replaceAll(link, `](${destination})`)
  }
  return content
}

async function writeSentinelPackage(
  directory: string,
  name: string,
  marker: string
): Promise<void> {
  const packageDirectory = join(directory, 'node_modules', name)
  await Bun.write(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      main: './sentinel.cjs',
      exports: './sentinel.cjs',
      bin: './sentinel.cjs',
      scripts: { postinstall: 'node sentinel.cjs' },
      keywords: ['tanstack-intent'],
      repository: { type: 'git', url: 'https://github.com/example/intent-fixture.git' }
    })
  )
  await Bun.write(
    join(packageDirectory, 'sentinel.cjs'),
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + '\n')})\n`
  )
  await Bun.write(
    join(packageDirectory, 'skills/sample/SKILL.md'),
    '---\nname: sample\ndescription: Intent policy sentinel fixture\n---\n\n# Fixture\n'
  )
}

async function assertRefused(directory: string, reference: string, reason: string): Promise<void> {
  const { exitCode, stdout, stderr } = await execute(
    ['node', intentCli, 'load', reference, '--json'],
    directory
  )
  assert.notEqual(exitCode, 0, `Intent allowed ${reference}`)
  assert.equal(stdout.trim(), '', `Intent printed guidance for ${reference}`)
  assert.ok(stderr.includes(reason), `Unexpected refusal for ${reference}: ${stderr}`)
}

async function run(command: [string, ...string[]], cwd: string): Promise<string> {
  const { exitCode, stdout, stderr } = await execute(command, cwd)
  if (exitCode !== 0)
    throw new Error(`${command.join(' ')} failed (${exitCode})\n${stdout.trim()}\n${stderr.trim()}`)
  return stdout
}

async function execute(command: [string, ...string[]], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HUSKY: '0' },
    signal: AbortSignal.timeout(60_000)
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return { stdout, stderr, exitCode }
}
