import { dlopen } from 'bun:ffi'

const extendedLimitInformation = 9
const killOnJobClose = 0x2000
// The 64-bit JOBOBJECT_EXTENDED_LIMIT_INFORMATION starts with two LARGE_INTEGERs
// followed by the DWORD LimitFlags. Bun supports 64-bit Windows.
const limits = new Uint8Array(144)
new DataView(limits.buffer).setUint32(16, killOnJobClose, true)

const { symbols } = dlopen('kernel32.dll', {
  CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'u64' },
  SetInformationJobObject: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'i32' },
  AssignProcessToJobObject: { args: ['u64', 'u64'], returns: 'i32' },
  GetCurrentProcess: { args: [], returns: 'u64' },
  GetLastError: { args: [], returns: 'u32' },
  CloseHandle: { args: ['u64'], returns: 'i32' }
})

function jobError(operation: string): Error {
  return new Error(`${operation} failed with Windows error ${symbols.GetLastError()}`)
}

function setKillOnClose(job: bigint): void {
  if (!symbols.SetInformationJobObject(job, extendedLimitInformation, limits, limits.byteLength)) {
    throw jobError('SetInformationJobObject')
  }
}

function attachToJob(): void {
  const job = symbols.CreateJobObjectW(null, null)
  if (job === 0n) throw jobError('CreateJobObjectW')
  try {
    setKillOnClose(job)
    if (!symbols.AssignProcessToJobObject(job, symbols.GetCurrentProcess())) {
      throw jobError('AssignProcessToJobObject')
    }
  } catch (error) {
    symbols.CloseHandle(job)
    throw error
  }
  // The launcher owns the only handle. Exiting for any reason closes it and
  // Windows terminates every process in the job, including orphaned descendants.
}

const [executable, ...args] = process.argv.slice(2)
if (!executable) throw new Error('Missing command for Windows Job Object launcher')
attachToJob()
const command = Bun.spawn([executable, ...args], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit'
})
process.exit(await command.exited)
