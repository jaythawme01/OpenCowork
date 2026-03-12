import { useState, useRef, useCallback, useMemo, useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTokens } from '@renderer/lib/format-tokens'
import {
  Plus,
  MessageSquare,
  CircleHelp,
  Trash2,
  Eraser,
  Search,
  Briefcase,
  Code2,
  Download,
  Copy,
  X,
  Pin,
  PinOff,
  Pencil,
  Loader2,
  CheckCircle2,
  PanelLeftClose,
  FolderOpen,
  FolderPlus,
  ChevronRight
} from 'lucide-react'
import { DynamicIcon } from 'lucide-react/dynamic'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { toast } from 'sonner'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import {
  abortSession,
  clearPendingSessionMessages,
  getPendingSessionMessageCountForSession,
  subscribePendingSessionMessages
} from '@renderer/hooks/use-chat-actions'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { cn } from '@renderer/lib/utils'

const modeIcons: Record<SessionMode, React.ReactNode> = {
  chat: <MessageSquare className="size-4" />,
  clarify: <CircleHelp className="size-4" />,
  cowork: <Briefcase className="size-4" />,
  code: <Code2 className="size-4" />
}

interface SessionListItem {
  id: string
  title: string
  icon?: string
  mode: SessionMode
  createdAt: number
  updatedAt: number
  pinned?: boolean
  messageCount: number
  pluginId?: string
  projectId?: string
}

interface ProjectListItem {
  id: string
  name: string
  updatedAt: number
  pluginId?: string
}

export function SessionListPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const projectsRaw = useChatStore((s) => s.projects)
  const projects = useMemo<ProjectListItem[]>(
    () =>
      projectsRaw.map((project) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        pluginId: project.pluginId
      })),
    [projectsRaw]
  )
  const sessionDigest = useChatStore((s) =>
    s.sessions
      .map((session) =>
        [
          session.id,
          session.title,
          session.icon ?? '',
          session.mode,
          session.createdAt,
          session.updatedAt,
          session.pinned ? 1 : 0,
          session.messageCount,
          session.messagesLoaded ? 1 : 0,
          session.pluginId ?? '',
          session.projectId ?? ''
        ].join('|')
      )
      .join('¦')
  )
  const sessions = useMemo<SessionListItem[]>(() => {
    void sessionDigest
    return useChatStore.getState().sessions.map((session) => ({
      id: session.id,
      title: session.title,
      icon: session.icon,
      mode: session.mode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      pinned: session.pinned,
      messageCount: session.messageCount,
      pluginId: session.pluginId,
      projectId: session.projectId
    }))
  }, [sessionDigest])
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const setActiveProject = useChatStore((s) => s.setActiveProject)
  const createProject = useChatStore((s) => s.createProject)
  const renameProject = useChatStore((s) => s.renameProject)
  const deleteProject = useChatStore((s) => s.deleteProject)
  const updateProjectDirectory = useChatStore((s) => s.updateProjectDirectory)
  const updateSessionTitle = useChatStore((s) => s.updateSessionTitle)
  const clearSessionMessages = useChatStore((s) => s.clearSessionMessages)
  const duplicateSession = useChatStore((s) => s.duplicateSession)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const togglePinSession = useChatStore((s) => s.togglePinSession)
  const mode = useUIStore((s) => s.mode)
  const providers = useProviderStore((s) => s.providers)
  const runningSessions = useAgentStore((s) => s.runningSessions)
  const runningSubAgentSessionIdsSig = useAgentStore((s) => s.runningSubAgentSessionIdsSig)
  const activeTeamSessionId = useTeamStore((s) => s.activeTeam?.sessionId ?? null)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    title: string
    msgCount: number
    queueCount: number
  } | null>(null)
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<{
    id: string
    name: string
    sessionCount: number
  } | null>(null)
  const [renameDialog, setRenameDialog] = useState<{
    type: 'project' | 'session'
    id: string
    currentName: string
  } | null>(null)
  const [directoryDialog, setDirectoryDialog] = useState<{
    projectId: string
    projectName: string
  } | null>(null)
  const [projectModelDialog, setProjectModelDialog] = useState<{
    projectId: string
    projectName: string
  } | null>(null)
  const [directoryValue, setDirectoryValue] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const projectIdSet = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const getSessionSnapshot = useCallback(
    (sessionId: string) =>
      useChatStore.getState().sessions.find((session) => session.id === sessionId),
    []
  )
  const runningSubAgentSessionIds = useMemo(
    () => new Set(runningSubAgentSessionIdsSig ? runningSubAgentSessionIdsSig.split('\u0000') : []),
    [runningSubAgentSessionIdsSig]
  )
  const pendingQueueSignature = useSyncExternalStore(
    subscribePendingSessionMessages,
    () =>
      sessions
        .map((session) => `${session.id}:${getPendingSessionMessageCountForSession(session.id)}`)
        .join('|'),
    () => ''
  )

  useEffect(() => {
    if (!renameDialog) return
    requestAnimationFrame(() => renameInputRef.current?.select())
  }, [renameDialog])

  const deleteTargetRunningInfo = useMemo(() => {
    void pendingQueueSignature
    if (!deleteTarget) return null
    const id = deleteTarget.id
    const isAgentRunning = runningSessions[id] === 'running'
    const hasActiveSubAgents = runningSubAgentSessionIds.has(id)
    const hasActiveTeam = activeTeamSessionId === id
    const hasRunning = isAgentRunning || hasActiveSubAgents || hasActiveTeam
    return { isAgentRunning, hasActiveSubAgents, hasActiveTeam, hasRunning }
  }, [
    deleteTarget,
    runningSessions,
    runningSubAgentSessionIds,
    activeTeamSessionId,
    pendingQueueSignature
  ])

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return
    const session = getSessionSnapshot(deleteTarget.id)
    if (!session) {
      setDeleteTarget(null)
      return
    }
    if (runningSessions[session.id] === 'running') {
      abortSession(session.id)
    }
    clearPendingSessionMessages(session.id)
    const snapshot = JSON.parse(JSON.stringify(session))
    deleteSession(session.id)
    setDeleteTarget(null)
    toast.success(t('sidebar_toast.sessionDeleted'), {
      action: {
        label: t('action.undo', { ns: 'common' }),
        onClick: () => useChatStore.getState().restoreSession(snapshot)
      },
      duration: 5000
    })
  }, [deleteTarget, deleteSession, getSessionSnapshot, runningSessions, t])

  const handleNewSession = (): void => {
    useUIStore.getState().navigateToHome()
  }

  const handleCreateProject = async (): Promise<void> => {
    const id = await createProject({ name: 'New Project' })
    setActiveProject(id)
    useUIStore.getState().navigateToHome()
    toast.success(t('sidebar_toast.projectCreated', { defaultValue: 'Project created' }))
  }

  const toggleProjectCollapsed = useCallback((projectId: string): void => {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const openRenameDialog = useCallback(
    (type: 'project' | 'session', id: string, currentName: string): void => {
      setRenameDialog({ type, id, currentName })
      setRenameValue(currentName)
    },
    []
  )

  const handleRenameProject = useCallback(
    (projectId: string, currentName: string): void => {
      openRenameDialog('project', projectId, currentName)
    },
    [openRenameDialog]
  )

  const confirmRename = useCallback((): void => {
    if (!renameDialog) return
    const nextName = renameValue.trim()
    if (!nextName) return

    const current = renameDialog.currentName.trim()
    if (nextName !== current) {
      if (renameDialog.type === 'project') {
        renameProject(renameDialog.id, nextName)
      } else {
        updateSessionTitle(renameDialog.id, nextName)
      }
      toast.success(t('action.rename', { ns: 'common' }))
    }

    setRenameDialog(null)
  }, [renameDialog, renameProject, renameValue, t, updateSessionTitle])

  const handleDeleteProject = useCallback(
    (projectId: string, projectName: string, sessionCount: number): void => {
      setProjectDeleteTarget({
        id: projectId,
        name: projectName,
        sessionCount
      })
    },
    []
  )

  const handleEditProjectDirectory = useCallback((projectId: string, projectName: string): void => {
    const project = useChatStore.getState().projects.find((item) => item.id === projectId)
    setDirectoryDialog({
      projectId,
      projectName
    })
    setDirectoryValue(project?.workingFolder ?? '')
  }, [])

  const handleEditProjectModel = useCallback((projectId: string, projectName: string): void => {
    setProjectModelDialog({ projectId, projectName })
  }, [])

  const confirmProjectDirectory = useCallback((): void => {
    if (!directoryDialog) return
    updateProjectDirectory(directoryDialog.projectId, {
      workingFolder: directoryValue.trim() || null,
      sshConnectionId: null
    })
    setDirectoryDialog(null)
    toast.success('项目工作目录已更新')
  }, [directoryDialog, directoryValue, updateProjectDirectory])

  const selectProjectDirectory = useCallback(async (): Promise<void> => {
    const result = (await window.electron.ipcRenderer.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (result.canceled) return
    setDirectoryValue(result.path ?? '')
  }, [])

  const chatProviderGroups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter(
            (model) => model.enabled && (!model.category || model.category === 'chat')
          )
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  const buildModelValue = useCallback((providerId: string, modelId: string): string => {
    return `${providerId}::${modelId}`
  }, [])

  const applyProjectModel = useCallback(
    (value: string): void => {
      if (!projectModelDialog) return
      const project = useChatStore.getState().projects.find((item) => item.id === projectModelDialog.projectId)
      if (!project) return
      if (value === '__global__') {
        const now = Date.now()
        useChatStore.setState((state) => {
          const target = state.projects.find((item) => item.id === projectModelDialog.projectId)
          if (!target) return
          target.providerId = undefined
          target.modelId = undefined
          target.updatedAt = now
        })
        setProjectModelDialog(null)
        toast.success('项目默认模型已改为跟随全局')
        return
      }
      const [providerId, modelId] = value.split('::')
      if (!providerId || !modelId) return
      const now = Date.now()
      useChatStore.setState((state) => {
        const target = state.projects.find((item) => item.id === projectModelDialog.projectId)
        if (!target) return
        target.providerId = providerId
        target.modelId = modelId
        target.updatedAt = now
      })
      setProjectModelDialog(null)
      toast.success('项目默认模型已更新')
    },
    [projectModelDialog]
  )

  const confirmDeleteProject = useCallback(async (): Promise<void> => {
    if (!projectDeleteTarget) return

    const relatedSessionIds = useChatStore
      .getState()
      .sessions.filter((session) => session.projectId === projectDeleteTarget.id)
      .map((session) => session.id)
    for (const sessionId of relatedSessionIds) {
      clearPendingSessionMessages(sessionId)
    }

    await deleteProject(projectDeleteTarget.id)
    setCollapsedProjectIds((prev) => {
      if (!prev.has(projectDeleteTarget.id)) return prev
      const next = new Set(prev)
      next.delete(projectDeleteTarget.id)
      return next
    })
    setProjectDeleteTarget(null)
    toast.success(t('sidebar_toast.projectDeleted', { defaultValue: 'Project deleted' }))
  }, [deleteProject, projectDeleteTarget, t])

  const handleExport = async (sessionId: string): Promise<void> => {
    await useChatStore.getState().loadSessionMessages(sessionId)
    const session = getSessionSnapshot(sessionId)
    if (!session) return
    const md = sessionToMarkdown(session)
    const filename =
      session.title
        .replace(/[^a-zA-Z0-9-_ ]/g, '')
        .slice(0, 50)
        .trim() || 'conversation'
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sortedSessions = sessions.slice().sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return b.updatedAt - a.updatedAt
  })

  const searchQuery = search.trim().toLowerCase()
  const contentSearchMeta = useMemo(() => {
    const matchedIds = new Set<string>()
    const snippetBySessionId = new Map<string, string>()
    if (!searchQuery) return { matchedIds, snippetBySessionId }

    void sessionDigest
    const rawSessions = useChatStore.getState().sessions
    for (const session of rawSessions) {
      if (
        session.title.toLowerCase().includes(searchQuery) ||
        session.mode.toLowerCase().includes(searchQuery)
      ) {
        continue
      }
      if (!session.messagesLoaded) continue
      for (const message of session.messages) {
        const text =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join('\n')
              : ''
        const lower = text.toLowerCase()
        const idx = lower.indexOf(searchQuery)
        if (idx === -1) continue
        matchedIds.add(session.id)
        const start = Math.max(0, idx - 20)
        const snippet =
          (start > 0 ? '...' : '') +
          text.slice(start, idx + searchQuery.length + 30).replace(/\n/g, ' ') +
          (idx + searchQuery.length + 30 < text.length ? '...' : '')
        snippetBySessionId.set(session.id, snippet)
        break
      }
    }

    return { matchedIds, snippetBySessionId }
  }, [searchQuery, sessionDigest])

  const filteredSessions = searchQuery
    ? sortedSessions.filter((session) => {
        if (session.title.toLowerCase().includes(searchQuery)) return true
        if (session.mode.toLowerCase().includes(searchQuery)) return true
        return contentSearchMeta.matchedIds.has(session.id)
      })
    : sortedSessions

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionListItem[]>()
    for (const session of filteredSessions) {
      if (!session.projectId) continue
      const list = map.get(session.projectId)
      if (list) {
        list.push(session)
      } else {
        map.set(session.projectId, [session])
      }
    }
    return map
  }, [filteredSessions])

  const filteredProjectGroups = useMemo(() => {
    const sortedProjects = projects.slice().sort((a, b) => {
      if (!!a.pluginId !== !!b.pluginId) return a.pluginId ? 1 : -1
      return b.updatedAt - a.updatedAt
    })

    const visibleGroups = sortedProjects
      .filter((project) => {
        const hasSessions = (sessionsByProject.get(project.id)?.length ?? 0) > 0
        if (!searchQuery) return true
        return project.name.toLowerCase().includes(searchQuery) || hasSessions
      })
      .map((project) => ({
        project,
        items: sessionsByProject.get(project.id) ?? [],
        isMissing: false
      }))

    const knownIds = new Set(sortedProjects.map((project) => project.id))
    for (const [projectId, items] of sessionsByProject.entries()) {
      if (knownIds.has(projectId)) continue
      visibleGroups.push({
        project: {
          id: projectId,
          name: t('sidebar.unknownProject', { defaultValue: 'Unknown Project' }),
          updatedAt: Date.now()
        },
        items,
        isMissing: true
      })
    }

    return visibleGroups
  }, [projects, sessionsByProject, searchQuery, t])

  return (
    <>
      <div className="flex h-full w-[20rem] shrink-0 flex-col border-r bg-background/50">
        {/* Header: title + new chat */}
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground/80">
              {t('sidebar.conversations')}
            </span>
            {sessions.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({sessions.length})</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {sessions.some((s) => s.messageCount > 0) && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => {
                  const withMessages = sessions.filter((s) => s.messageCount > 0)
                  Promise.all(withMessages.map((s) => handleExport(s.id)))
                    .then(() => toast.success(t('sidebar_toast.exported')))
                    .catch(() => {})
                }}
                title={t('sidebar.exportAll')}
              >
                <Download className="size-3" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => void handleCreateProject()}
              title={t('sidebar.newProject', { defaultValue: 'New Project' })}
            >
              <FolderPlus className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleNewSession}
              title={t('sidebar.newChat')}
            >
              <Plus className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => useUIStore.getState().setLeftSidebarOpen(false)}
              title={t('sidebar.collapse', { defaultValue: 'Collapse sidebar' })}
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Search */}
        {sessions.length > 3 && (
          <div className="px-3 pb-1.5 pt-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/60" />
              <Input
                ref={searchRef}
                placeholder={t('sidebar.filterSessions')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearch('')
                    searchRef.current?.blur()
                  }
                }}
                className={`h-7 rounded-lg pl-7 text-xs bg-muted/50 border-transparent focus:border-border transition-colors ${search ? 'pr-6' : ''}`}
              />
              {search && (
                <>
                  <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/40 pointer-events-none">
                    {filteredSessions.length}/{sortedSessions.length}
                  </span>
                  <button
                    onClick={() => {
                      setSearch('')
                      searchRef.current?.focus()
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="size-3" />
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-1.5">
          {filteredProjectGroups.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {sessions.length === 0 ? t('sidebar.noConversations') : t('sidebar.noMatches')}
            </div>
          ) : (
            <>
              {filteredProjectGroups.map((group) => {
                const isCollapsed = collapsedProjectIds.has(group.project.id)
                const canManageProject = !group.isMissing && projectIdSet.has(group.project.id)

                return (
                  <div key={group.project.id} className="mb-1.5">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <button
                          className={cn(
                            'mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
                            activeProjectId === group.project.id
                              ? 'bg-muted text-foreground'
                              : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                          )}
                          onClick={() => setActiveProject(group.project.id)}
                          title={group.project.name}
                        >
                          <span
                            className="inline-flex size-4 shrink-0 items-center justify-center"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleProjectCollapsed(group.project.id)
                            }}
                          >
                            <ChevronRight
                              className={cn(
                                'size-3.5 transition-transform duration-200 ease-in-out',
                                !isCollapsed && 'rotate-90'
                              )}
                            />
                          </span>
                          <FolderOpen className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{group.project.name}</span>
                          <span className="text-xs text-muted-foreground/60">
                            {group.items.length}
                          </span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuItem
                          disabled={!canManageProject}
                          onClick={() => handleRenameProject(group.project.id, group.project.name)}
                        >
                          <Pencil className="size-4" />
                          {t('action.rename', { ns: 'common' })}
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={!canManageProject}
                          onClick={() => handleEditProjectDirectory(group.project.id, group.project.name)}
                        >
                          <FolderOpen className="size-4" />
                          修改工作目录
                        </ContextMenuItem>
                        <ContextMenuSub>
                          <ContextMenuSubTrigger inset>修改默认模型</ContextMenuSubTrigger>
                          <ContextMenuSubContent className="w-72">
                            <ContextMenuItem
                              onClick={() => handleEditProjectModel(group.project.id, group.project.name)}
                            >
                              打开模型选择
                            </ContextMenuItem>
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          disabled={!canManageProject}
                          onClick={() =>
                            handleDeleteProject(
                              group.project.id,
                              group.project.name,
                              group.items.length
                            )
                          }
                        >
                          <Trash2 className="size-4" />
                          {t('action.delete', { ns: 'common' })}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    <div
                      className={cn(
                        'grid transition-[grid-template-rows,opacity] duration-200 ease-in-out',
                        isCollapsed
                          ? 'grid-rows-[0fr] opacity-0 pointer-events-none'
                          : 'grid-rows-[1fr] opacity-100'
                      )}
                    >
                      <div className="overflow-hidden">
                        {group.items.map((session) => (
                          <ContextMenu key={session.id}>
                            <ContextMenuTrigger asChild>
                              <button
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                                  session.id === activeSessionId &&
                                    useUIStore.getState().chatView === 'session' &&
                                    !useUIStore.getState().settingsPageOpen
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-foreground/80 hover:bg-muted/60'
                                )}
                                onClick={() => {
                                  setActiveSession(session.id)
                                  useUIStore.getState().navigateToSession()
                                }}
                                onDoubleClick={(e) => {
                                  e.preventDefault()
                                  setEditingId(session.id)
                                  setEditTitle(session.title)
                                  setTimeout(() => editRef.current?.select(), 0)
                                }}
                              >
                                <span className="shrink-0">
                                  {session.pinned ? (
                                    <Pin className="size-3.5 text-muted-foreground/50" />
                                  ) : session.icon ? (
                                    <DynamicIcon name={session.icon as never} className="size-4" />
                                  ) : (
                                    modeIcons[session.mode]
                                  )}
                                </span>
                                {editingId === session.id ? (
                                  <input
                                    ref={editRef}
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    onBlur={() => {
                                      const trimmed = editTitle.trim()
                                      if (trimmed && trimmed !== session.title) {
                                        useChatStore
                                          .getState()
                                          .updateSessionTitle(session.id, trimmed)
                                        toast.success(t('action.rename', { ns: 'common' }))
                                      }
                                      setEditingId(null)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                      if (e.key === 'Escape') {
                                        setEditingId(null)
                                      }
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className="h-6 w-full min-w-0 rounded border bg-background px-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                                  />
                                ) : (
                                  <div className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-sm leading-4">
                                      {session.title}
                                    </span>
                                    {searchQuery &&
                                      !session.title.toLowerCase().includes(searchQuery) &&
                                      contentSearchMeta.snippetBySessionId.get(session.id) && (
                                        <span className="truncate text-[9px] text-muted-foreground/40">
                                          {contentSearchMeta.snippetBySessionId.get(session.id)}
                                        </span>
                                      )}
                                  </div>
                                )}
                                {editingId !== session.id && (
                                  <span className="ml-auto flex shrink-0 items-center gap-1">
                                    {runningSessions[session.id] === 'running' && (
                                      <Loader2 className="size-3.5 animate-spin text-blue-500" />
                                    )}
                                    {runningSessions[session.id] === 'completed' && (
                                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                                    )}
                                    {getPendingSessionMessageCountForSession(session.id) > 0 && (
                                      <span className="rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                                        {getPendingSessionMessageCountForSession(session.id)}
                                      </span>
                                    )}
                                    {session.pinned && (
                                      <Pin className="size-3 text-muted-foreground/30 -rotate-45" />
                                    )}
                                    {session.mode !== mode && (
                                      <span className="rounded bg-muted px-1 py-px text-[8px] uppercase text-muted-foreground/40">
                                        {session.mode}
                                      </span>
                                    )}
                                    {session.messageCount > 0 && (
                                      <span className="text-[10px] text-muted-foreground/40">
                                        {session.messageCount}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </button>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-48">
                              <ContextMenuItem
                                onClick={() =>
                                  openRenameDialog('session', session.id, session.title)
                                }
                              >
                                <Pencil className="size-4" />
                                {t('action.rename', { ns: 'common' })}
                              </ContextMenuItem>
                              {session.messageCount > 0 && (
                                <>
                                  <ContextMenuItem
                                    onClick={async () => {
                                      await handleExport(session.id)
                                      toast.success(t('sidebar_toast.exportedOne'))
                                    }}
                                  >
                                    <Download className="size-4" />
                                    {t('sidebar.exportAsMarkdown')}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onClick={async () => {
                                      await useChatStore.getState().loadSessionMessages(session.id)
                                      const snapshot = getSessionSnapshot(session.id)
                                      if (!snapshot) return
                                      const json = JSON.stringify(snapshot, null, 2)
                                      const blob = new Blob([json], {
                                        type: 'application/json'
                                      })
                                      const url = URL.createObjectURL(blob)
                                      const a = document.createElement('a')
                                      a.href = url
                                      a.download = `${
                                        session.title
                                          .replace(/[^a-zA-Z0-9-_ ]/g, '')
                                          .slice(0, 50)
                                          .trim() || 'session'
                                      }.json`
                                      a.click()
                                      URL.revokeObjectURL(url)
                                      toast.success(t('sidebar_toast.exportedAsJson'))
                                    }}
                                  >
                                    <Download className="size-4" />
                                    {t('sidebar.exportAsJson')}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onClick={() => {
                                      duplicateSession(session.id)
                                      toast.success(t('sidebar_toast.sessionDuplicated'))
                                    }}
                                  >
                                    <Copy className="size-4" />
                                    {t('action.duplicate', { ns: 'common' })}
                                  </ContextMenuItem>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem
                                    onClick={() => {
                                      clearSessionMessages(session.id)
                                      clearPendingSessionMessages(session.id)
                                      toast.success(t('sidebar_toast.messagesCleared'))
                                    }}
                                  >
                                    <Eraser className="size-4" />
                                    {t('sidebar.clearMessages')}
                                  </ContextMenuItem>
                                </>
                              )}
                              <ContextMenuItem
                                onClick={() => {
                                  togglePinSession(session.id)
                                  toast.success(
                                    session.pinned
                                      ? t('sidebar_toast.unpinned')
                                      : t('sidebar_toast.pinnedMsg')
                                  )
                                }}
                              >
                                {session.pinned ? (
                                  <PinOff className="size-4" />
                                ) : (
                                  <Pin className="size-4" />
                                )}
                                {session.pinned
                                  ? t('action.unpin', { ns: 'common' })
                                  : t('sidebar.pinToTop')}
                              </ContextMenuItem>
                              <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                  {modeIcons[session.mode]}
                                  {t('sidebar.switchMode')}
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent>
                                  {(['chat', 'clarify', 'cowork', 'code'] as const).map((m) => (
                                    <ContextMenuItem
                                      key={m}
                                      disabled={session.mode === m}
                                      onClick={() => {
                                        updateSessionMode(session.id, m)
                                        toast.success(t('sidebar_toast.switchedMode', { mode: m }))
                                      }}
                                    >
                                      {modeIcons[m]}
                                      <span className="capitalize">{m}</span>
                                    </ContextMenuItem>
                                  ))}
                                </ContextMenuSubContent>
                              </ContextMenuSub>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                variant="destructive"
                                onClick={() => {
                                  const hasRunning =
                                    runningSessions[session.id] === 'running' ||
                                    runningSubAgentSessionIds.has(session.id) ||
                                    activeTeamSessionId === session.id
                                  const queueCount = getPendingSessionMessageCountForSession(
                                    session.id
                                  )
                                  if (session.messageCount > 0 || hasRunning || queueCount > 0) {
                                    setDeleteTarget({
                                      id: session.id,
                                      title: session.title,
                                      msgCount: session.messageCount,
                                      queueCount
                                    })
                                    return
                                  }
                                  const snapshot = getSessionSnapshot(session.id)
                                  if (!snapshot) return
                                  clearPendingSessionMessages(snapshot.id)
                                  deleteSession(snapshot.id)
                                  toast.success(t('sidebar_toast.sessionDeleted'), {
                                    action: {
                                      label: t('action.undo', { ns: 'common' }),
                                      onClick: () =>
                                        useChatStore.getState().restoreSession(snapshot)
                                    },
                                    duration: 5000
                                  })
                                }}
                              >
                                <Trash2 className="size-4" />
                                {t('action.delete', { ns: 'common' })}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>

        {/* Footer stats */}
        <div className="border-t px-3 py-2">
          <p className="text-center text-[10px] text-muted-foreground/25">
            {sessions.length} {t('sidebar.sessions')} ·{' '}
            {sessions.reduce((sum, session) => sum + session.messageCount, 0)} {t('sidebar.msgs')}
            {(() => {
              const rawSessions = useChatStore.getState().sessions
              let total = rawSessions.reduce(
                (a, s) =>
                  a +
                  s.messages.reduce(
                    (b, m) => b + (m.usage ? m.usage.inputTokens + m.usage.outputTokens : 0),
                    0
                  ),
                0
              )
              const teamState = useTeamStore.getState()
              const allMembers = [
                ...(teamState.activeTeam?.members ?? []),
                ...teamState.teamHistory.flatMap((t) => t.members)
              ]
              for (const m of allMembers) {
                if (m.usage) total += m.usage.inputTokens + m.usage.outputTokens
              }
              return total > 0 ? ` · ${formatTokens(total)} tokens` : ''
            })()}
          </p>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sidebar.deleteConversation')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t('sidebar.deleteConfirm', {
                    title: deleteTarget?.title
                  })}
                </p>
                {deleteTarget?.queueCount ? (
                  <p>
                    {t('sidebar.deleteQueuedMessagesNotice', {
                      defaultValue: '该会话还有 {{count}} 条待发送消息，也会一起删除。',
                      count: deleteTarget.queueCount
                    })}
                  </p>
                ) : null}
                {deleteTargetRunningInfo?.hasRunning && (
                  <p className="font-medium text-destructive">
                    {t('sidebar.deleteRunningNotice', {
                      defaultValue: '该会话存在正在运行的任务，删除前会先停止当前运行。'
                    })}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('action.cancel', { ns: 'common' })}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              {deleteTargetRunningInfo?.hasRunning
                ? t('sidebar.stopAndDelete')
                : t('action.delete', { ns: 'common' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!projectDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setProjectDeleteTarget(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('sidebar.deleteProject', { defaultValue: 'Delete project' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('sidebar.deleteProjectConfirm', {
                defaultValue:
                  (projectDeleteTarget?.sessionCount ?? 0) > 0
                    ? `Delete project "${projectDeleteTarget?.name ?? ''}" and ${projectDeleteTarget?.sessionCount ?? 0} sessions?`
                    : `Delete project "${projectDeleteTarget?.name ?? ''}"?`,
                projectName: projectDeleteTarget?.name ?? '',
                count: projectDeleteTarget?.sessionCount ?? 0
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('action.cancel', { ns: 'common' })}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void confirmDeleteProject()
              }}
            >
              {t('action.delete', { ns: 'common' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!projectModelDialog}
        onOpenChange={(open) => {
          if (!open) setProjectModelDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-lg p-4">
          <DialogHeader>
            <DialogTitle className="text-sm">
              修改项目默认模型{projectModelDialog ? ` · ${projectModelDialog.projectName}` : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => applyProjectModel('__global__')}
            >
              跟随全局默认模型
            </Button>
            {chatProviderGroups.map(({ provider, models }) => (
              <div key={`project-model-${provider.id}`} className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-1">
                  {provider.name}
                </div>
                {models.map((model) => (
                  <Button
                    key={`project-model-${provider.id}-${model.id}`}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => applyProjectModel(buildModelValue(provider.id, model.id))}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ModelIcon
                        icon={model.icon}
                        modelId={model.id}
                        providerBuiltinId={provider.builtinId}
                        size={16}
                        className="text-muted-foreground/70"
                      />
                      <div className="flex min-w-0 flex-col items-start text-left">
                        <span className="truncate max-w-[220px]">{model.name}</span>
                        <span className="text-[10px] text-muted-foreground/60 truncate max-w-[220px]">
                          {model.id}
                        </span>
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!directoryDialog}
        onOpenChange={(open) => {
          if (!open) setDirectoryDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-lg p-4">
          <DialogHeader>
            <DialogTitle className="text-sm">
              修改项目工作目录{directoryDialog ? ` · ${directoryDialog.projectName}` : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={directoryValue}
              onChange={(event) => setDirectoryValue(event.target.value)}
              placeholder="输入本地工作目录，留空表示清空"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  confirmProjectDirectory()
                }
                if (event.key === 'Escape') {
                  setDirectoryDialog(null)
                }
              }}
            />
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => void selectProjectDirectory()}>
                浏览...
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDirectoryDialog(null)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button size="sm" onClick={confirmProjectDirectory}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!renameDialog}
        onOpenChange={(open) => {
          if (!open) setRenameDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {renameDialog?.type === 'project'
                ? t('sidebar.renameProject', { defaultValue: 'Rename project' })
                : t('sidebar.renameSession')}
            </DialogTitle>
          </DialogHeader>
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmRename()
              }
              if (event.key === 'Escape') {
                setRenameDialog(null)
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameDialog(null)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button size="sm" onClick={confirmRename} disabled={!renameValue.trim()}>
              {t('action.rename', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
