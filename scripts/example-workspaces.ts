import { join, resolve } from 'node:path'

export const repository = resolve(import.meta.dir, '..')
const phases = ['build', 'typecheck', 'test', 'smoke']

export async function exampleProjects(): Promise<string[]> {
  const { workspaces } = (await Bun.file(join(repository, 'package.json')).json()) as {
    workspaces: string[]
  }
  return workspaces
    .filter((workspace) => workspace.startsWith('examples/'))
    .map((workspace) => {
      const project = /^examples\/([\w-]+)$/u.exec(workspace)?.[1]
      if (!project) throw new Error(`Expected an explicit example workspace, got ${workspace}`)
      return project
    })
}

export async function exampleGates(cwd: string): Promise<string[]> {
  const { scripts = {} } = (await Bun.file(join(cwd, 'package.json')).json()) as {
    scripts?: Record<string, string>
  }
  const missing = phases.find((phase) => !scripts[phase])
  if (missing) throw new Error(`Missing ${missing} script in ${cwd}`)

  // A plain chain of commands can cover earlier phases. Keep all phases for compound scripts.
  const smoke = scripts.smoke ?? ''
  if (!/^[\w./ -]+(?:&&[\w./ -]+)*$/u.test(smoke)) return phases
  const commands = new Set(smoke.split('&&').map((command) => command.trim()))
  return phases.filter((phase) => phase === 'smoke' || !commands.has(`bun --bun run ${phase}`))
}

if (import.meta.main) {
  const [phase] = process.argv.slice(2)
  if (phase !== undefined && !phases.includes(phase))
    throw new Error(`Unknown example phase: ${phase}`)
  for (const project of await exampleProjects()) {
    const cwd = join(repository, 'examples', project)
    const gates = phase === undefined ? await exampleGates(cwd) : [phase]
    for (const gate of gates) {
      const child = Bun.spawn([process.execPath, '--bun', 'run', gate], {
        cwd,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit'
      })
      const status = await child.exited
      if (status !== 0) process.exit(status)
    }
  }
}
