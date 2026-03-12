import { BrowserWindow } from 'electron'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { nanoid } from 'nanoid'
import { getDb } from '../db/database'
import * as projectsDao from '../db/projects-dao'
import type { ChannelEvent, ChannelInstance, ChannelIncomingMessageData } from './channel-types'
import type { ChannelManager } from './channel-manager'
import { tryHandleCommand } from './plugin-commands'

const PLUGINS_WORK_DIR = path.join(os.homedir(), '.open-cowork', 'plugins')
const PLUGINS_FILE = path.join(os.homedir(), '.open-cowork', 'plugins.json')

function shouldReplaceSessionTitle(currentTitle: string | undefined, nextTitle: string | undefined): boolean {
  const current = (currentTitle ?? '').trim()
  const next = (nextTitle ?? '').trim()
  if (!next || current === next) return false

  return (
    current.length === 0 ||
    current === 'New Conversation' ||
    current === 'New Chat' ||
    /^oc_/i.test(current) ||
    /^Plugin\s+/i.test(current)
  )
}

let _pluginManager: ChannelManager | null = null

/** Must be called once at startup to wire the plugin manager */
export function setPluginManager(pm: ChannelManager): void {
  _pluginManager = pm
}

/**
 * Auto-reply pipeline: routes incoming plugin messages to per-user/per-group sessions
 * and notifies the renderer to trigger the Agent Loop for auto-reply.
 */
export function handleChannelAutoReply(event: ChannelEvent): void {
  if (event.type !== 'incoming_message') return

  const data = event.data as ChannelIncomingMessageData
  if (!data || !data.chatId || (!data.content && !data.images?.length && !data.audio)) return

  const pluginId = event.pluginId
  const compositeKey = `plugin:${pluginId}:chat:${data.chatId}`

  try {
    const db = getDb()

    let pluginInstance: ChannelInstance | undefined
    try {
      if (fs.existsSync(PLUGINS_FILE)) {
        const plugins = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as ChannelInstance[]
        pluginInstance = plugins.find((p) => p.id === pluginId)
      }
    } catch { /* ignore read errors */ }

    const pluginProject = projectsDao.ensurePluginProject(
      pluginId,
      pluginInstance?.name || `Plugin ${pluginId}`
    )
    const pluginWorkDir = pluginProject.working_folder ?? path.join(PLUGINS_WORK_DIR, pluginId)
    const pluginSshConnectionId = pluginProject.ssh_connection_id ?? null

    let session = db
      .prepare('SELECT id, title, project_id FROM sessions WHERE external_chat_id = ? LIMIT 1')
      .get(compositeKey) as { id: string; title: string; project_id?: string | null } | undefined

    const now = Date.now()
    const sessionProviderId = pluginInstance?.providerId ?? null
    const sessionModelId = pluginInstance?.model ?? null

    if (!session) {
      const sessionId = nanoid()
      const title = data.chatName || data.senderName || data.chatId
      db.prepare(
        `INSERT INTO sessions (id, title, icon, mode, created_at, updated_at, project_id, working_folder, ssh_connection_id, pinned, plugin_id, external_chat_id, provider_id, model_id)
         VALUES (?, ?, NULL, 'cowork', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      ).run(
        sessionId,
        title,
        now,
        now,
        pluginProject.id,
        pluginWorkDir,
        pluginSshConnectionId,
        pluginId,
        compositeKey,
        sessionProviderId,
        sessionModelId
      )
      session = { id: sessionId, title, project_id: pluginProject.id }
    } else {
      db.prepare(
        `UPDATE sessions
            SET updated_at = ?,
                project_id = ?,
                working_folder = ?,
                ssh_connection_id = ?
          WHERE id = ?`
      ).run(now, pluginProject.id, pluginWorkDir, pluginSshConnectionId, session.id)

      if (sessionProviderId || sessionModelId) {
        db.prepare('UPDATE sessions SET provider_id = ?, model_id = ? WHERE id = ?')
          .run(sessionProviderId, sessionModelId, session.id)
      }

      const betterTitle = data.chatName || data.senderName
      if (shouldReplaceSessionTitle(session.title, betterTitle)) {
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(betterTitle, session.id)
        session.title = betterTitle
      }
    }

    // ── Command interception: handle /help, /new, /init, /status etc. before agent loop ──
    // Always attempt command parsing — tryHandleCommand handles @mention stripping internally
    if (_pluginManager && data.content?.trim()) {
      const commandResult = tryHandleCommand({
        pluginId,
        pluginType: event.pluginType,
        chatId: data.chatId,
        data,
        sessionId: session.id,
        pluginWorkDir,
        pluginManager: _pluginManager,
      })
      // true = fully handled, skip agent loop
      if (commandResult === true) return
      // string = command rewrote the message, pass to agent loop with new content
      if (typeof commandResult === 'string') {
        data.content = commandResult
      }
      // false = not a command, proceed with original content
    }

    // NOTE: We do NOT insert the user message here — the renderer's sendMessage
    // will handle it (via triggerSendMessage) to avoid duplicate messages and
    // ensure proper multi-modal content handling.

    // Check if the plugin service supports streaming
    const service = _pluginManager?.getService(pluginId)
    const supportsStreaming = !!(service?.supportsStreaming && service?.sendStreamingMessage)

    // Notify renderer to trigger Agent Loop auto-reply
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('plugin:session-task', {
        sessionId: session.id,
        pluginId,
        pluginType: event.pluginType,
        chatId: data.chatId,
        senderId: data.senderId,
        senderName: data.senderName,
        chatName: data.chatName,
        sessionTitle: session.title,
        content: data.content
          || (data.images?.length ? '[User sent an image]' : '')
          || (data.audio ? '[User sent an audio message]' : ''),
        messageId: data.messageId,
        supportsStreaming,
        images: data.images,
        audio: data.audio,
        chatType: data.chatType,
        projectId: pluginProject.id,
        workingFolder: pluginWorkDir,
        sshConnectionId: pluginSshConnectionId,
      })
    }

    console.log(
      `[AutoReply] Routed message from ${data.senderName || data.senderId} ` +
      `in chat ${data.chatId} to session ${session.id}`
    )
  } catch (err) {
    console.error('[AutoReply] Failed to route incoming message:', err)
  }
}
