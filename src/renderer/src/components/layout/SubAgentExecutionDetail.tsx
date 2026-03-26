import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquareText,
  Wrench,
  X,
  icons
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { ToolCallCard } from '@renderer/components/chat/ToolCallCard'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { cn } from '@renderer/lib/utils'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'

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

function getReportStatusLabel(
  status: SubAgentState['reportStatus'],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  switch (status) {
    case 'submitted':
      return t('subAgentsPanel.reportStatusSubmitted', { defaultValue: '已提交' })
    case 'retrying':
      return t('subAgentsPanel.reportStatusRetrying', { defaultValue: '补救中' })
    case 'fallback':
      return t('subAgentsPanel.reportStatusFallback', { defaultValue: '兜底生成' })
    case 'missing':
      return t('subAgentsPanel.reportStatusMissing', { defaultValue: '缺失' })
    case 'pending':
    default:
      return t('subAgentsPanel.reportStatusPending', { defaultValue: '待生成' })
  }
}

function getAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Bot className="size-4" />
}

function findTargetAgent(
  toolUseId: string | null | undefined,
  activeSessionId: string | null,
  activeSubAgents: Record<string, SubAgentState>,
  completedSubAgents: Record<string, SubAgentState>,
  subAgentHistory: SubAgentState[]
): SubAgentState | null {
  if (!toolUseId) return null

  const direct =
    activeSubAgents[toolUseId] ??
    completedSubAgents[toolUseId] ??
    subAgentHistory.find((item) => item.toolUseId === toolUseId)
  if (!direct) return null

  if (!activeSessionId) return direct
  if (!direct.sessionId || direct.sessionId === activeSessionId) return direct

  return (
    subAgentHistory.find(
      (item) => item.toolUseId === toolUseId && item.sessionId === activeSessionId
    ) ?? direct
  )
}

export function SubAgentExecutionDetail({
  toolUseId,
  inlineText,
  embedded = false,
  onClose
}: {
  toolUseId?: string | null
  inlineText?: string
  embedded?: boolean
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const subAgentHistory = useAgentStore((s) => s.subAgentHistory)

  const agent = React.useMemo(
    () =>
      findTargetAgent(
        toolUseId,
        activeSessionId,
        activeSubAgents,
        completedSubAgents,
        subAgentHistory
      ),
    [toolUseId, activeSessionId, activeSubAgents, completedSubAgents, subAgentHistory]
  )

  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!agent?.isRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [agent?.isRunning, agent?.startedAt])

  if (!agent) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background/40 px-6 text-center">
        <Bot className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          {t('detailPanel.noSubAgentRecords', { defaultValue: '暂无子代理记录' })}
        </p>
        {inlineText ? (
          <div className="mt-4 max-w-3xl text-left prose prose-sm max-w-none dark:prose-invert">
            <Markdown remarkPlugins={[remarkGfm]}>{inlineText}</Markdown>
          </div>
        ) : null}
      </div>
    )
  }

  const displayName = agent.displayName ?? agent.name
  const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
  const summaryText = agent.report.trim() || agent.streamingText.trim() || inlineText?.trim() || ''
  const icon = getAgentIcon(displayName)

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col', embedded ? 'bg-transparent' : 'bg-background')}
    >
      <div className="border-b border-border/60 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-muted/25 text-foreground/80">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-lg font-semibold text-foreground/95">
                {displayName}
              </h2>
              <Badge
                variant="secondary"
                className={cn(
                  'h-6 rounded-full border border-border/60 bg-background/70 px-2.5 text-[11px] font-medium text-foreground/75',
                  agent.isRunning && 'border-cyan-500/30 bg-cyan-500/10 text-cyan-100'
                )}
              >
                {agent.isRunning
                  ? t('subAgentsPanel.running', { defaultValue: '运行中' })
                  : t('subAgentsPanel.completed', { defaultValue: '已完成' })}
              </Badge>
            </div>
            {agent.description ? (
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground/80">
                {agent.description}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground/70">
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                <Clock3 className="size-3.5" />
                {elapsed}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                <CheckCircle2 className="size-3.5" />
                {t('detailPanel.iterations', {
                  count: agent.iteration,
                  defaultValue: `迭代：${agent.iteration}`
                })}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                <Wrench className="size-3.5" />
                {t('detailPanel.toolCalls', {
                  count: agent.toolCalls.length,
                  defaultValue: `工具调用：${agent.toolCalls.length}`
                })}
              </span>
            </div>
          </div>
          {onClose ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-9 rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="grid min-h-full gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-5">
            <section className="rounded-2xl border border-border/60 bg-background/70 p-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                <MessageSquareText className="size-3.5" />
                <span>{t('subAgentsPanel.report', { defaultValue: '总结报告' })}</span>
                {agent.isRunning ? <Loader2 className="size-3 animate-spin" /> : null}
              </div>
              {summaryText ? (
                <div className="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                  <Markdown remarkPlugins={[remarkGfm]}>{summaryText}</Markdown>
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

            <section className="rounded-2xl border border-border/60 bg-background/70 p-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                <CalendarClock className="size-3.5" />
                <span>{t('subAgentsPanel.execution', { defaultValue: '执行过程' })}</span>
              </div>
              <div className="min-w-0 prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                <TranscriptMessageList
                  messages={agent.transcript}
                  streamingMessageId={agent.currentAssistantMessageId}
                />
              </div>
            </section>

            <section className="rounded-2xl border border-border/60 bg-background/70 p-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                <Wrench className="size-3.5" />
                <span>{t('detailPanel.toolCallsLabel', { defaultValue: '工具调用' })}</span>
              </div>
              {agent.toolCalls.length > 0 ? (
                <div className="space-y-2">
                  {agent.toolCalls.map((toolCall) => (
                    <ToolCallCard
                      key={toolCall.id}
                      toolUseId={toolCall.id}
                      name={toolCall.name}
                      input={toolCall.input}
                      output={toolCall.output}
                      status={toolCall.status}
                      error={toolCall.error}
                      startedAt={toolCall.startedAt}
                      completedAt={toolCall.completedAt}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground/70">
                  {t('subAgentsPanel.noToolCalls', { defaultValue: '暂无工具调用记录' })}
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-5 xl:sticky xl:top-0 xl:self-start">
            <section className="rounded-2xl border border-border/60 bg-background/70 p-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                <Bot className="size-3.5" />
                <span>{t('subAgentsPanel.executionInfo', { defaultValue: '执行信息' })}</span>
              </div>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.description', { defaultValue: '描述' })}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-foreground/88">
                    {agent.description || '—'}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.promptLabel', { defaultValue: 'Prompt' })}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-foreground/88">
                    {agent.prompt || '—'}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border/60 bg-background/70 p-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                <Clock3 className="size-3.5" />
                <span>{t('subAgentsPanel.time', { defaultValue: '时间' })}</span>
              </div>
              <div className="space-y-3 text-sm text-foreground/88">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.startedAt', { defaultValue: '开始' })}
                  </div>
                  <div>{formatDateTime(agent.startedAt)}</div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.finishedAt', { defaultValue: '结束' })}
                  </div>
                  <div>{formatDateTime(agent.completedAt)}</div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.statusLabel', { defaultValue: '状态' })}
                  </div>
                  <div>{getReportStatusLabel(agent.reportStatus, t)}</div>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
