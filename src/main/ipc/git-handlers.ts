import { ipcMain } from 'electron'
import { spawn } from 'child_process'

function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 })
    })
    child.on('error', (error) => {
      resolve({ stdout, stderr: error.message || stderr, exitCode: 1 })
    })
  })
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:get-head', async (_event, args: { cwd: string }) => {
    const result = await execGit(['rev-parse', 'HEAD'], args.cwd)
    if (result.exitCode !== 0) return { error: result.stderr || 'Failed to get HEAD' }
    return { commitId: result.stdout.trim() }
  })

  ipcMain.handle('git:get-range-commits', async (_event, args: { cwd: string; base: string; head?: string }) => {
    const head = args.head?.trim() || 'HEAD'
    const result = await execGit(['log', '--format=%H', `${args.base}..${head}`], args.cwd)
    if (result.exitCode !== 0) return { error: result.stderr || 'Failed to get commit range' }
    return { commits: normalizeLines(result.stdout) }
  })

  ipcMain.handle('git:get-changed-files', async (_event, args: { cwd: string; base: string; head?: string }) => {
    const head = args.head?.trim() || 'HEAD'
    const result = await execGit(['diff', '--name-only', `${args.base}..${head}`], args.cwd)
    if (result.exitCode !== 0) return { error: result.stderr || 'Failed to get changed files' }
    return { files: normalizeLines(result.stdout) }
  })

  ipcMain.handle('git:get-status', async (_event, args: { cwd: string }) => {
    const result = await execGit(['status', '--short'], args.cwd)
    if (result.exitCode !== 0) return { error: result.stderr || 'Failed to get git status' }
    return { files: normalizeLines(result.stdout), dirty: normalizeLines(result.stdout).length > 0 }
  })
}
