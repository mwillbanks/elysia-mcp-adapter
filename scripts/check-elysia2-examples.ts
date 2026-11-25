import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { exampleGates, exampleProjects, repository } from './example-workspaces'
import { runBun as run } from './run-bun'

const adapter = '@mwillbanks/elysia-mcp-adapter'
const elysiaVersion = '2.0.0-rc.5'

interface Manifest {
  dependencies?: Record<string, string>
  [key: string]: unknown
}

function parseArguments(projects: string[]): { projects: string[]; archive?: string } {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: { archive: { type: 'string' } },
    allowPositionals: true
  })
  const unknownProject = positionals.find((project) => !projects.includes(project))
  if (unknownProject !== undefined)
    throw new Error(`Unknown example project: ${unknownProject}. Choose ${projects.join(', ')}`)
  const selected = [...new Set(positionals)]
  return {
    projects: selected.length > 0 ? selected : [...projects],
    archive: values.archive ? resolveArchive(values.archive) : undefined
  }
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

async function verifyProject(project: string, directory: string): Promise<void> {
  const cwd = join(directory, 'examples', project)
  for (const gate of await exampleGates(cwd)) await run(['run', gate], cwd)
  console.log(`Elysia ${elysiaVersion}: ${relative(directory, cwd)} passed`)
}

async function main(): Promise<void> {
  const options = parseArguments(await exampleProjects())
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
