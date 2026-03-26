import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  Loader2,
  PanelLeftClose,
  Sparkles,
  icons
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { cn } from '@renderer/lib/utils'

const DAY_MS = 24 * 60 * 60 * 1000

type PanelFilter = 'all' | 'running' | 'completed' | 'today'

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function getAgentSortTime(
  agent: Pick<SubAgentState, 'isRunning' | 'startedAt' | 'completedAt'>
): number {
  return agent.isRunning ? agent.startedAt : (agent.completedAt ?? agent.startedAt)
}

function getHistoryGroupLabel(
  ts: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const now = new Date()
  const target = new Date(ts)
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
  const diffDays = Math.floor((nowStart - targetStart) / DAY_MS)

  if (diffDays === 0) return t('subAgentsPanel.groupToday', { defaultValue: '今天' })
  if (diffDays === 1) return t('subAgentsPanel.groupYesterday', { defaultValue: '昨天' })
  return target.toLocaleDateString()
}

function isSameDay(ts: number): boolean {
  const now = new Date()
  const target = new Date(ts)
  return (
    now.getFullYear() === target.getFullYear() &&
    now.getMonth() === target.getMonth() &&
    now.getDate() === target.getDate()
  )
}

function getAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Bot className="size-4" />
}

function getAgentSummary(agent: SubAgentState): string {
  return agent.report.trim() || agent.streamingText.trim()
}

function getPreviewText(text: string, isRunning: boolean): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const limit = isRunning ? 260 : 320
  if (trimmed.length <= limit) return trimmed
  return isRunning ? `…${trimmed.slice(-limit)}` : `${trimmed.slice(0, limit)}…`
}

function matchesFilter(agent: SubAgentState, filter: PanelFilter): boolean {
  switch (filter) {
    case 'running':
      return agent.isRunning
    case 'completed':
      return !agent.isRunning
    case 'today':
      return isSameDay(agent.completedAt ?? agent.startedAt)
    case 'all':
    default:
      return true
  }
}

export function SubAgentsPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const subAgentHistory = useAgentStore((s) => s.subAgentHistory)
  const selectedToolUseId = useUIStore((s) => s.selectedSubAgentToolUseId)
  const setSelectedToolUseId = useUIStore((s) => s.setSelectedSubAgentToolUseId)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)
  const openSubAgentExecutionDetail = useUIStore((s) => s.openSubAgentExecutionDetail)
  const [now, setNow] = React.useState(() => Date.now())
  const [filter, setFilter] = React.useState<PanelFilter>('all')
  const [expandedIds, setExpandedIds] = React.useState<Record<string, boolean>>({})

  const allAgents = React.useMemo(() => {
    const merged = new Map<string, SubAgentState>()

    for (const agent of subAgentHistory) {
      if (agent.sessionId === activeSessionId) merged.set(agent.toolUseId, agent)
    }
    for (const agent of Object.values(completedSubAgents)) {
      if (agent.sessionId === activeSessionId) merged.set(agent.toolUseId, agent)
    }
    for (const agent of Object.values(activeSubAgents)) {
      if (agent.sessionId === activeSessionId) merged.set(agent.toolUseId, agent)
    }

    return [...merged.values()].sort(
      (left, right) => getAgentSortTime(right) - getAgentSortTime(left)
    )
  }, [activeSessionId, activeSubAgents, completedSubAgents, subAgentHistory])

  const runningAgents = React.useMemo(
    () => allAgents.filter((agent) => agent.isRunning && matchesFilter(agent, filter)),
    [allAgents, filter]
  )

  const completedGroups = React.useMemo(() => {
    const groups = new Map<string, { label: string; items: SubAgentState[] }>()

    for (const agent of allAgents) {
      if (agent.isRunning || !matchesFilter(agent, filter)) continue
      const groupTs = agent.completedAt ?? agent.startedAt
      const label = getHistoryGroupLabel(groupTs, t)
      const group = groups.get(label)
      if (group) {
        group.items.push(agent)
      } else {
        groups.set(label, { label, items: [agent] })
      }
    }

    return [...groups.values()]
  }, [allAgents, filter, t])

  React.useEffect(() => {
    const hasRunning = allAgents.some((agent) => agent.isRunning)
    if (!hasRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [allAgents])

  React.useEffect(() => {
    if (!selectedToolUseId) return
    if (!allAgents.some((agent) => agent.toolUseId === selectedToolUseId)) return

    setExpandedIds((prev) =>
      prev[selectedToolUseId] ? prev : { ...prev, [selectedToolUseId]: true }
    )

    const timer = window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>(
        `[data-subagent-card="${selectedToolUseId}"]`
      )
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)

    return () => window.clearTimeout(timer)
  }, [selectedToolUseId, allAgents])

  const visibleCount =
    runningAgents.length + completedGroups.reduce((sum, group) => sum + group.items.length, 0)

  if (!activeSessionId || allAgents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground">
        {t('detailPanel.noSubAgentRecords')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/30">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-2xl border border-border/60 bg-muted/25 text-foreground/80">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground/92">
                {t('subAgentsPanel.title', { defaultValue: '任务执行' })}
              </h2>
              <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
                {visibleCount}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground/65">
              {t('subAgentsPanel.subtitle', {
                defaultValue: '运行中置顶，历史按日期分组，结果优先展示'
              })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => setRightPanelOpen(false)}
            title={t('rightPanel.collapse')}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ['all', t('subAgentsPanel.filterAll', { defaultValue: '全部' })],
              ['running', t('subAgentsPanel.filterRunning', { defaultValue: '运行中' })],
              ['completed', t('subAgentsPanel.filterCompleted', { defaultValue: '已完成' })],
              ['today', t('subAgentsPanel.filterToday', { defaultValue: '今天' })]
            ] as Array<[PanelFilter, string]>
          ).map(([value, label]) => {
            const active = filter === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'border-foreground/15 bg-foreground/8 text-foreground'
                    : 'border-border/60 bg-background/55 text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {runningAgents.length > 0 ? (
          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
              <Loader2 className="size-3 animate-spin" />
              <span>{t('subAgentsPanel.running', { defaultValue: '运行中' })}</span>
            </div>
            <div className="space-y-3">
              {runningAgents.map((agent) => (
                <SubAgentRunCard
                  key={agent.toolUseId}
                  agent={agent}
                  now={now}
                  expanded={!!expandedIds[agent.toolUseId]}
                  highlighted={selectedToolUseId === agent.toolUseId}
                  onToggle={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    setExpandedIds((prev) => ({
                      ...prev,
                      [agent.toolUseId]: !prev[agent.toolUseId]
                    }))
                  }}
                  onOpenDetail={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    openSubAgentExecutionDetail(agent.toolUseId)
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {completedGroups.map((group) => (
          <section key={group.label} className="mb-4 last:mb-0">
            <div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
              <CalendarDays className="size-3" />
              <span>{group.label}</span>
            </div>
            <div className="space-y-3">
              {group.items.map((agent) => (
                <SubAgentRunCard
                  key={agent.toolUseId}
                  agent={agent}
                  now={now}
                  expanded={!!expandedIds[agent.toolUseId]}
                  highlighted={selectedToolUseId === agent.toolUseId}
                  onToggle={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    setExpandedIds((prev) => ({
                      ...prev,
                      [agent.toolUseId]: !prev[agent.toolUseId]
                    }))
                  }}
                  onOpenDetail={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    openSubAgentExecutionDetail(agent.toolUseId)
                  }}
                />
              ))}
            </div>
          </section>
        ))}

        {visibleCount === 0 ? (
          <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background/40 text-sm text-muted-foreground">
            {t('subAgentsPanel.emptyFiltered', {
              defaultValue: '当前筛选条件下暂无执行记录'
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SubAgentRunCard({
  agent,
  now,
  expanded,
  highlighted,
  onToggle,
  onOpenDetail
}: {
  agent: SubAgentState
  now: number
  expanded: boolean
  highlighted: boolean
  onToggle: () => void
  onOpenDetail: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const displayName = agent.displayName ?? agent.name
  const summary = getAgentSummary(agent)
  const previewText = getPreviewText(summary, agent.isRunning)
  const icon = getAgentIcon(displayName)
  const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)

  return (
    <div
      data-subagent-card={agent.toolUseId}
      className={cn(
        'overflow-hidden rounded-2xl border bg-background/70 transition-colors',
        highlighted
          ? 'border-foreground/15 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]'
          : 'border-border/60 hover:border-border'
      )}
    >
      <button type="button" onClick={onToggle} className="w-full px-4 py-4 text-left">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-muted/25 text-foreground/80">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-foreground/92">
                {displayName}
              </span>
              <Badge
                variant="secondary"
                className={cn(
                  'h-5 rounded-full border border-border/60 bg-background/70 px-2 text-[10px] font-medium text-foreground/70',
                  agent.isRunning && 'border-cyan-500/30 bg-cyan-500/10 text-cyan-100'
                )}
              >
                {agent.isRunning
                  ? t('subAgentsPanel.running', { defaultValue: '运行中' })
                  : t('subAgentsPanel.completed', { defaultValue: '已完成' })}
              </Badge>
            </div>

            {agent.description ? (
              <p className="mt-1 line-clamp-1 whitespace-pre-wrap break-words text-xs text-muted-foreground/70">
                {agent.description}
              </p>
            ) : null}

            {previewText ? (
              <div className="mt-3 rounded-2xl border border-border/60 bg-muted/20 px-3 py-3">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                  <Sparkles className="size-3" />
                  <span>
                    {agent.isRunning
                      ? t('subAgentsPanel.recentProgress', { defaultValue: '最近进度' })
                      : t('subAgentsPanel.summary', { defaultValue: '结果摘要' })}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/88 line-clamp-5">
                  {previewText}
                </p>
              </div>
            ) : (
              <div className="mt-3 rounded-2xl border border-dashed border-border/60 bg-muted/15 px-3 py-3 text-sm text-muted-foreground/65">
                {agent.isRunning
                  ? t('subAgentsPanel.summaryStreaming', {
                      defaultValue: '正在生成进度摘要…'
                    })
                  : t('subAgentsPanel.summaryEmpty', { defaultValue: '暂无可展示摘要' })}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/65">
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                <Clock3 className="size-3" />
                {elapsed}
              </span>
              <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                {t('detailPanel.iterations', {
                  count: agent.iteration,
                  defaultValue: `迭代：${agent.iteration}`
                })}
              </span>
              <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                {t('detailPanel.toolCalls', {
                  count: agent.toolCalls.length,
                  defaultValue: `工具调用：${agent.toolCalls.length}`
                })}
              </span>
              <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                {formatDateTime(agent.completedAt ?? agent.startedAt)}
              </span>
            </div>
          </div>
          <div className="mt-1 text-muted-foreground/50">
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border/60 px-4 py-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-4">
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                  {t('subAgentsPanel.reportBody', { defaultValue: '结果正文' })}
                </div>
                {summary ? (
                  <div className="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                    <Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground/70">
                    {agent.reportStatus === 'retrying'
                      ? t('subAgentsPanel.reportStatusRetrying', { defaultValue: '补救中' })
                      : agent.reportStatus === 'missing'
                        ? t('subAgentsPanel.reportMissing', { defaultValue: '未捕获到总结报告。' })
                        : t('subAgentsPanel.reportPending', {
                            defaultValue: '当前执行尚未生成总结报告。'
                          })}
                  </div>
                )}
              </section>
            </div>

            <aside className="space-y-4 rounded-2xl border border-border/60 bg-muted/15 p-4">
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                  描述
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/88">
                  {agent.description || '—'}
                </div>
              </section>
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                  Prompt
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/88">
                  {agent.prompt || '—'}
                </div>
              </section>
              <Button className="w-full gap-2" onClick={onOpenDetail}>
                {t('subAgentsPanel.openFullDetail', { defaultValue: '打开完整详情' })}
                <ExternalLink className="size-4" />
              </Button>
            </aside>
          </div>
        </div>
      ) : null}
    </div>
  )
}
