import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Bot, FileText, GitCommitHorizontal, RefreshCw, RotateCcw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useChatStore } from '@renderer/stores/chat-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { CodeEditor } from '@renderer/components/editor/CodeEditor'

interface WikiDocumentRow {
  id: string
  project_id: string
  name: string
  slug: string
  description: string
  status: string
  content_markdown: string
  generation_mode: string
  last_generated_commit_id: string | null
  created_at: number
  updated_at: number
}

interface WikiProjectStateRow {
  project_id: string
  wiki_enabled: number
  wiki_search_enabled: number
  last_full_generated_commit_id: string | null
  last_incremental_generated_commit_id: string | null
  last_exported_at: number | null
  last_generation_status: string
  last_generation_error: string | null
  updated_at: number
}

interface WikiSectionSourceRow {
  id: string
  section_id: string
  file_path: string
  symbol_hint: string | null
  reason: string
}

interface WikiSectionRow {
  id: string
  title: string
  anchor: string
  summary: string
  content_markdown: string
  sources: WikiSectionSourceRow[]
}

export function ProjectWikiPage(): React.JSX.Element {
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projects = useChatStore((state) => state.projects)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const [documents, setDocuments] = useState<WikiDocumentRow[]>([])
  const [projectState, setProjectState] = useState<WikiProjectStateRow | null>(null)
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [sections, setSections] = useState<WikiSectionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [runningAction, setRunningAction] = useState<'generate' | 'regenerate' | 'incremental' | null>(null)

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documents]
  )

  const loadData = async (): Promise<void> => {
    if (!activeProjectId) {
      setDocuments([])
      setProjectState(null)
      setActiveDocumentId(null)
      setDraftContent('')
      setLoading(false)
      return
    }
    setLoading(true)
    const [docs, state] = await Promise.all([
      ipcClient.invoke(IPC.DB_WIKI_LIST_DOCUMENTS, activeProjectId),
      ipcClient.invoke(IPC.DB_WIKI_GET_PROJECT_STATE, activeProjectId)
    ])
    const nextDocuments = (docs as WikiDocumentRow[]) ?? []
    const nextState = (state as WikiProjectStateRow | null) ?? null
    setDocuments(nextDocuments)
    setProjectState(nextState)
    const nextActive = nextDocuments[0]?.id ?? null
    setActiveDocumentId((current) => current ?? nextActive)
    setDraftContent(nextDocuments[0]?.content_markdown ?? '')
    setLoading(false)
  }

  useEffect(() => {
    void loadData()
  }, [activeProjectId])

  useEffect(() => {
    setDraftContent(activeDocument?.content_markdown ?? '')
  }, [activeDocument?.id, activeDocument?.content_markdown])

  useEffect(() => {
    const loadDetail = async (): Promise<void> => {
      if (!activeDocumentId) {
        setSections([])
        return
      }
      const detail = (await ipcClient.invoke(IPC.DB_WIKI_GET_DOCUMENT_DETAIL, activeDocumentId)) as {
        document: WikiDocumentRow
        sections: WikiSectionRow[]
      } | null
      setSections(detail?.sections ?? [])
    }
    void loadDetail()
  }, [activeDocumentId])

  const handleSave = async (): Promise<void> => {
    if (!activeProjectId || !activeDocument) return
    setSaving(true)
    const updated = (await ipcClient.invoke(IPC.DB_WIKI_SAVE_DOCUMENT, {
      id: activeDocument.id,
      projectId: activeProjectId,
      name: activeDocument.name,
      slug: activeDocument.slug,
      description: activeDocument.description,
      status: 'edited',
      contentMarkdown: draftContent,
      generationMode: activeDocument.generation_mode,
      lastGeneratedCommitId: activeDocument.last_generated_commit_id
    })) as WikiDocumentRow
    setDocuments((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    setSaving(false)
  }

  const toggleWikiSearch = async (enabled: boolean): Promise<void> => {
    if (!activeProjectId) return
    const nextState = (await ipcClient.invoke(IPC.DB_WIKI_SAVE_PROJECT_STATE, {
      projectId: activeProjectId,
      patch: { wikiSearchEnabled: enabled, wikiEnabled: true }
    })) as WikiProjectStateRow
    setProjectState(nextState)
    window.dispatchEvent(
      new CustomEvent('opencowork:wiki-search-changed', {
        detail: { projectId: activeProjectId, enabled }
      })
    )
  }

  const handleGenerate = async (): Promise<void> => {
    if (!activeProjectId) return
    setRunningAction('generate')
    const result = (await ipcClient.invoke(IPC.WIKI_GENERATE_FULL, { projectId: activeProjectId })) as {
      error?: string
    }
    setRunningAction(null)
    if (result?.error) {
      toast.error(result.error)
      return
    }
    toast.success('Wiki 已生成')
    await loadData()
  }

  const handleRegenerate = async (): Promise<void> => {
    if (!activeProjectId) return
    setRunningAction('regenerate')
    const result = (await ipcClient.invoke(IPC.WIKI_REGENERATE, { projectId: activeProjectId })) as {
      error?: string
    }
    setRunningAction(null)
    if (result?.error) {
      toast.error(result.error)
      return
    }
    toast.success('Wiki 已重新生成')
    await loadData()
  }

  const handleIncrementalGenerate = async (): Promise<void> => {
    if (!activeProjectId) return
    setRunningAction('incremental')
    const result = (await ipcClient.invoke(IPC.WIKI_GENERATE_INCREMENTAL, {
      projectId: activeProjectId
    })) as {
      error?: string
      skipped?: boolean
      reason?: string
    }
    setRunningAction(null)
    if (result?.error) {
      toast.error(result.error)
      return
    }
    if (result?.skipped) {
      toast.info(result.reason ?? '无需增量更新')
      return
    }
    toast.success('Wiki 已增量更新')
    await loadData()
  }

  if (!activeProject) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">先选择项目</div>
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-80 shrink-0 flex-col border-r bg-muted/20">
        <div className="border-b p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BookOpen className="size-4 text-primary" />
            <span>项目 Wiki</span>
          </div>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center justify-between rounded-md border px-2 py-1.5">
              <span className="flex items-center gap-1"><Bot className="size-3.5" />启用 Wiki 搜索</span>
              <Switch checked={projectState?.wiki_search_enabled === 1} onCheckedChange={toggleWikiSearch} />
            </div>
            <div className="rounded-md border px-2 py-1.5">
              <div className="flex items-center gap-1"><GitCommitHorizontal className="size-3.5" />上次全量 Commit</div>
              <div className="mt-1 break-all text-[11px]">{projectState?.last_full_generated_commit_id ?? '—'}</div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" className="h-7 flex-1 text-[11px]" onClick={() => void handleIncrementalGenerate()} disabled={runningAction !== null}>
                <RefreshCw className="size-3.5" />{runningAction === 'incremental' ? '增量中' : '增量生成'}
              </Button>
              <Button size="sm" variant="outline" className="h-7 flex-1 text-[11px]" onClick={() => void handleGenerate()} disabled={runningAction !== null}>
                <RotateCcw className="size-3.5" />{runningAction === 'generate' ? '生成中' : '全量生成'}
              </Button>
              <Button size="sm" variant="outline" className="h-7 flex-1 text-[11px]" onClick={() => void handleRegenerate()} disabled={runningAction !== null}>
                <RotateCcw className="size-3.5" />{runningAction === 'regenerate' ? '重建中' : '重新生成'}
              </Button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="px-2 py-6 text-xs text-muted-foreground">正在加载 Wiki...</div>
          ) : documents.length === 0 ? (
            <div className="px-2 py-6 text-xs text-muted-foreground">暂无 Wiki 文档</div>
          ) : (
            <div className="space-y-1">
              {documents.map((document) => (
                <button
                  key={document.id}
                  className={`w-full rounded-lg border px-3 py-2 text-left ${document.id === activeDocumentId ? 'border-primary/30 bg-primary/8' : 'border-transparent hover:border-border hover:bg-background/60'}`}
                  onClick={() => setActiveDocumentId(document.id)}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FileText className="size-3.5 text-muted-foreground" />
                    <span className="truncate">{document.name}</span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{document.description || '无描述'}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground/80">状态：{document.status}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{activeDocument?.name ?? '项目 Wiki'}</div>
            <div className="truncate text-xs text-muted-foreground">{activeDocument?.description ?? activeProject.workingFolder ?? '尚未生成文档'}</div>
            <div className="text-[11px] text-muted-foreground">文档状态：{activeDocument?.status ?? '—'}</div>
          </div>
          <Button size="sm" className="h-8 gap-1 text-xs" onClick={() => void handleSave()} disabled={!activeDocument || saving}>
            <Save className="size-3.5" />保存
          </Button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <CodeEditor
              filePath={`${activeDocument?.slug ?? 'wiki'}.md`}
              language="markdown"
              content={draftContent}
              onChange={setDraftContent}
              onSave={handleSave}
            />
          </div>
          <div className="w-72 shrink-0 border-l bg-muted/10 p-3">
            <div className="text-xs font-medium">章节来源文件</div>
            <div className="mt-2 space-y-3 overflow-y-auto text-[11px] text-muted-foreground">
              {sections.length === 0 ? (
                <div>暂无章节来源</div>
              ) : (
                sections.map((section) => (
                  <div key={section.id} className="rounded-md border bg-background/70 p-2">
                    <div className="font-medium text-foreground">{section.title}</div>
                    <div className="mt-1 space-y-1">
                      {section.sources.length === 0 ? (
                        <div>无来源文件</div>
                      ) : (
                        section.sources.map((source) => (
                          <div key={source.id} className="break-all">`{source.file_path}`</div>
                        ))
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
