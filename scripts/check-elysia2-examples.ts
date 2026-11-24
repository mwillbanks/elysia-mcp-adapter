import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runBun as run } from './run-bun'

const repository = resolve(import.meta.dir, '..')
const projects = [
  'core',
  'apps-vanilla',
  'apps-react',
  'auth',
  'tasks',
  'skills',
  'events',
  'experimental'
] as const
const adapter = '@mwillbanks/elysia-mcp-adapter'
const elysiaVersion = '2.0.0-rc.5'

interface Manifest {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

function parseArguments(): { projects: string[]; archive?: string } {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: { archive: { type: 'string' } },
    allowPositionals: true
  })
  const selected = [...new Set(positionals.map(validateProject))]
  return {
    projects: selected.length > 0 ? selected : [...projects],
    archive: values.archive ? resolveArchive(values.archive) : undefined
  }
}

function validateProject(project: string): string {
  if (!projects.includes(project as (typeof projects)[number]))
    throw new Error(`Unknown example project: ${project}. Choose ${projects.join(', ')}`)
  return project
}

function resolveArchive(path: string): string {
  const archive = resolve(path)
  if (!statSync(archive).isFile()) throw new Error('The adapter archive must be a file')
  return archive
}

async function stageProject(project: string, directory: string, archive: string): Promise<void> {
  const destination = join(directory, 'examples', project)
  cpSync(join(repository, 'examples', project), destination, {
    recursive: true,
    filter: (path) => {
      const name = basename(path)
      return (
        !['node_modules', 'dist', 'coverage', 'bun.lock', '.DS_Store'].includes(name) &&
        (!name.startsWith('.env') || name === '.env.example') &&
        !/\.(?:sqlite|sqlite-shm|sqlite-wal|db)$/u.test(name)
      )
    }
  })
  const overlay = join(repository, 'examples', 'elysia-2', project)
  if (existsSync(overlay)) cpSync(overlay, destination, { recursive: true })
  const manifestPath = join(destination, 'package.json')
  const manifest = (await Bun.file(manifestPath).json()) as Manifest
  manifest.dependencies = {
    ...manifest.dependencies,
    [adapter]: archive,
    elysia: elysiaVersion
  }
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function packAdapter(directory: string): Promise<string> {
  await run(['run', 'build'], repository)
  await run(['pm', 'pack', '--ignore-scripts', '--destination', directory], repository)
  const name = readdirSync(directory).find((entry) => entry.endsWith('.tgz'))
  if (!name) throw new Error('Bun pack did not create an adapter archive')
  return join(directory, name)
}

async function stageWorkspace(
  directory: string,
  selected: string[],
  archive: string
): Promise<void> {
  await Promise.all(selected.map((project) => stageProject(project, directory, archive)))
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        workspaces: selected.map((project) => `examples/${project}`),
        devDependencies: { '@types/bun': '1.4.4', typescript: '7.0.2' }
      },
      null,
      2
    )
  )
  cpSync(join(repository, 'tsconfig.json'), join(directory, 'tsconfig.json'))
  const scriptDirectory = join(directory, 'scripts')
  mkdirSync(scriptDirectory)
  cpSync(
    join(repository, 'scripts', 'verify-app-build.ts'),
    join(scriptDirectory, 'verify-app-build.ts')
  )
  await run(['install', '--ignore-scripts'], directory)
}

function projectGates(manifest: Manifest, project: string): string[] {
  const scripts = manifest.scripts ?? {}
  const gates = ['build', 'typecheck', 'test', 'smoke']
  for (const gate of gates) {
    if (!scripts[gate]) throw new Error(`Missing ${gate} script in ${project}`)
  }
  // Only exact unconditional smoke commands cover a separate gate.
  const smokeCommands = new Set(scripts.smoke.split('&&').map((command) => command.trim()))
  return gates.filter((gate) => gate === 'smoke' || !smokeCommands.has(`bun --bun run ${gate}`))
}

async function verifyProject(project: string, directory: string): Promise<void> {
  const cwd = join(directory, 'examples', project)
  const manifest = (await Bun.file(join(cwd, 'package.json')).json()) as Manifest
  for (const gate of projectGates(manifest, project)) await run(['run', gate], cwd)
  console.log(`Elysia ${elysiaVersion}: ${relative(directory, cwd)} passed`)
}

async function main(): Promise<void> {
  const options = parseArguments()
  const directory = mkdtempSync(join(tmpdir(), 'elysia2-examples-'))
  try {
    const archive = options.archive ?? (await packAdapter(directory))
    await stageWorkspace(directory, options.projects, archive)
    for (const project of options.projects) await verifyProject(project, directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

await main()
