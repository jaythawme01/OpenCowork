import { createHash } from 'crypto'
import * as fs from 'fs'
import { ipcMain } from 'electron'

type RunChangeStatus = 'open' | 'accepted' | 'reverting' | 'reverted' | 'conflicted'
type ChangeOp = 'create' | 'modify'

interface ChangeMeta {
  runId?: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
}

interface FileSnapshot {
  exists: boolean
  text?: string
  hash: string | null
  size: number
}

interface TrackedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  op: ChangeOp
  before: FileSnapshot
  after: FileSnapshot
  createdAt: number
  revertedAt?: number
  conflict?: string
}

interface RunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: RunChangeStatus
  changes: TrackedFileChange[]
  createdAt: number
  updatedAt: number
}

const runChanges = new Map<string, RunChangeSet>()

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function toSnapshot(exists: boolean, text?: string): FileSnapshot {
  if (!exists) {
    return {
      exists: false,
      hash: null,
      size: 0
    }
  }

  const normalizedText = text ?? ''
  return {
    exists: true,
    text: normalizedText,
    hash: hashText(normalizedText),
    size: Buffer.byteLength(normalizedText, 'utf-8')
  }
}

function readCurrentSnapshot(filePath: string): FileSnapshot {
  if (!fs.existsSync(filePath)) {
    return toSnapshot(false)
  }

  const stats = fs.statSync(filePath)
  if (!stats.isFile()) {
    return {
      exists: true,
      hash: null,
      size: 0
    }
  }

  const text = fs.readFileSync(filePath, 'utf-8')
  return toSnapshot(true, text)
}

function cloneSnapshot(snapshot: FileSnapshot): FileSnapshot {
  return {
    exists: snapshot.exists,
    text: snapshot.text,
    hash: snapshot.hash,
    size: snapshot.size
  }
}

function cloneChange(change: TrackedFileChange): TrackedFileChange {
  return {
    ...change,
    before: cloneSnapshot(change.before),
    after: cloneSnapshot(change.after)
  }
}

function cloneRunChangeSet(changeSet: RunChangeSet): RunChangeSet {
  return {
    ...changeSet,
    changes: changeSet.changes.map(cloneChange)
  }
}

function getOrCreateRunChangeSet(
  meta: Required<Pick<ChangeMeta, 'runId'>> & ChangeMeta
): RunChangeSet {
  const existing = runChanges.get(meta.runId)
  if (existing) {
    if (!existing.sessionId && meta.sessionId) {
      existing.sessionId = meta.sessionId
    }
    existing.updatedAt = Date.now()
    if (existing.status === 'reverted') {
      existing.status = 'open'
    }
    return existing
  }

  const createdAt = Date.now()
  const created: RunChangeSet = {
    runId: meta.runId,
    sessionId: meta.sessionId,
    assistantMessageId: meta.runId,
    status: 'open',
    changes: [],
    createdAt,
    updatedAt: createdAt
  }
  runChanges.set(meta.runId, created)
  return created
}

export function recordLocalTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  beforeExists: boolean
  beforeText?: string
  afterText: string
}): void {
  const runId = args.meta?.runId?.trim()
  if (!runId) return

  const before = toSnapshot(args.beforeExists, args.beforeText)
  const after = toSnapshot(true, args.afterText)
  if (before.exists === after.exists && before.hash === after.hash) {
    return
  }

  const changeSet = getOrCreateRunChangeSet({ ...args.meta, runId })
  changeSet.status = 'open'
  changeSet.updatedAt = Date.now()
  changeSet.changes.push({
    id: `${runId}:${changeSet.changes.length + 1}`,
    runId,
    sessionId: args.meta?.sessionId,
    toolUseId: args.meta?.toolUseId,
    toolName: args.meta?.toolName,
    filePath: args.filePath,
    op: before.exists ? 'modify' : 'create',
    before,
    after,
    createdAt: Date.now()
  })
}

function getRunChangeSet(runId: string): RunChangeSet | null {
  const changeSet = runChanges.get(runId)
  return changeSet ? cloneRunChangeSet(changeSet) : null
}

function acceptRunChangeSet(runId: string): RunChangeSet | null {
  const changeSet = runChanges.get(runId)
  if (!changeSet) return null
  changeSet.status = 'accepted'
  changeSet.updatedAt = Date.now()
  return cloneRunChangeSet(changeSet)
}

function rollbackRunChangeSet(runId: string): {
  success: boolean
  revertedCount: number
  conflictCount: number
  conflicts: Array<{ filePath: string; reason: string }>
  changeset: RunChangeSet | null
} {
  const changeSet = runChanges.get(runId)
  if (!changeSet) {
    return {
      success: false,
      revertedCount: 0,
      conflictCount: 0,
      conflicts: [],
      changeset: null
    }
  }

  changeSet.status = 'reverting'
  changeSet.updatedAt = Date.now()

  let revertedCount = 0
  let conflictCount = 0
  const conflicts: Array<{ filePath: string; reason: string }> = []

  for (const change of [...changeSet.changes].reverse()) {
    if (change.revertedAt) continue

    const current = readCurrentSnapshot(change.filePath)
    if (change.op === 'create') {
      if (!current.exists) {
        change.revertedAt = Date.now()
        revertedCount += 1
        continue
      }

      if (current.hash !== change.after.hash) {
        change.conflict = 'File changed since this agent run completed'
        conflictCount += 1
        conflicts.push({ filePath: change.filePath, reason: change.conflict })
        continue
      }

      fs.rmSync(change.filePath, { force: true })
      change.revertedAt = Date.now()
      change.conflict = undefined
      revertedCount += 1
      continue
    }

    if (!current.exists) {
      change.conflict = 'File is missing and cannot be restored safely'
      conflictCount += 1
      conflicts.push({ filePath: change.filePath, reason: change.conflict })
      continue
    }

    if (current.hash !== change.after.hash) {
      change.conflict = 'File changed since this agent run completed'
      conflictCount += 1
      conflicts.push({ filePath: change.filePath, reason: change.conflict })
      continue
    }

    fs.writeFileSync(change.filePath, change.before.text ?? '', 'utf-8')
    change.revertedAt = Date.now()
    change.conflict = undefined
    revertedCount += 1
  }

  changeSet.status = conflictCount > 0 ? 'conflicted' : 'reverted'
  changeSet.updatedAt = Date.now()

  return {
    success: conflictCount === 0,
    revertedCount,
    conflictCount,
    conflicts,
    changeset: cloneRunChangeSet(changeSet)
  }
}

export function registerAgentChangeHandlers(): void {
  ipcMain.handle('agent:changes:list', async (_event, args: { runId: string }) => {
    try {
      if (!args?.runId) return null
      return getRunChangeSet(args.runId)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('agent:changes:accept', async (_event, args: { runId: string }) => {
    try {
      if (!args?.runId) return { error: 'runId is required' }
      return {
        success: true,
        changeset: acceptRunChangeSet(args.runId)
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('agent:changes:rollback', async (_event, args: { runId: string }) => {
    try {
      if (!args?.runId) return { error: 'runId is required' }
      return rollbackRunChangeSet(args.runId)
    } catch (err) {
      return { error: String(err) }
    }
  })
}
