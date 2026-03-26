import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Clock, Loader2, Maximize2, icons } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { useAgentStore } from '@renderer/stores/agent-store'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { useUIStore } from '@renderer/stores/ui-store'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import { cn } from '@renderer/lib/utils'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import type { ToolResultContent } from '@renderer/lib/api/types'

function getSubAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Brain className="size-4" />
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

export const SubAgentCard = React.memo(SubAgentCardInner)

interface SubAgentCardProps {
  name: string
  toolUseId: string
  input: Record<string, unknown>
  output?: ToolResultContent
  isLive?: boolean
}

function SubAgentCardInner({
  name,
  toolUseId,
  input,
  output,
  isLive = false
}: SubAgentCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')

  const displayName = String(input.subagent_type ?? name)
  const live = useAgentStore((s) =>
    isLive ? (s.activeSubAgents[toolUseId] ?? s.completedSubAgents[toolUseId] ?? null) : null
  )

  const outputStr = typeof output === 'string' ? output : undefined
  const parsed = React.useMemo(() => {
    if (!outputStr) return { meta: null, text: '' }
    return parseSubAgentMeta(outputStr)
  }, [outputStr])
  const histMeta = parsed.meta
  const histText = parsed.text || outputStr || ''

  const isRunning = live?.isRunning ?? false
  const isCompleted = !isRunning && (!!output || (live && !live.isRunning))
  const isError = outputStr
    ? (() => {
        const parsedOutput = decodeStructuredToolResult(outputStr)
        if (
          parsedOutput &&
          !Array.isArray(parsedOutput) &&
          typeof parsedOutput.error === 'string'
        ) {
          return true
        }
        const parsedHistText = decodeStructuredToolResult(histText)
        return !!(
          parsedHistText &&
          !Array.isArray(parsedHistText) &&
          typeof parsedHistText.error === 'string'
        )
      })()
    : false

  const [now, setNow] = React.useState(live?.startedAt ?? 0)
  React.useEffect(() => {
    if (!live?.isRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live?.isRunning, live?.startedAt])

  const elapsed = live ? (live.completedAt ?? now) - live.startedAt : (histMeta?.elapsed ?? null)
  const icon = getSubAgentIcon(displayName)

  const descriptionText = input.description ? String(input.description) : ''
  const promptText = [
    input.prompt ? String(input.prompt) : '',
    input.query ? String(input.query) : '',
    input.task ? String(input.task) : '',
    input.target ? String(input.target) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const previewSource = live?.report || live?.streamingText || histText || ''
  const previewText = React.useMemo(() => {
    const trimmed = previewSource.trim()
    if (!trimmed) return ''
    const limit = isRunning ? 220 : 260
    if (trimmed.length <= limit) return trimmed
    return isRunning ? `…${trimmed.slice(-limit)}` : `${trimmed.slice(0, limit)}…`
  }, [previewSource, isRunning])

  const handleOpenPanel = (): void => {
    useUIStore.getState().openSubAgentsPanel(toolUseId)
  }

  return (
    <div
      className={cn(
        'my-4 overflow-hidden rounded-2xl border bg-background/60 p-4 transition-colors',
        isRunning && 'border-violet-500/25 bg-violet-500/[0.03]',
        isCompleted && !isError && 'border-border/60',
        isError && 'border-destructive/30 bg-destructive/5',
        !isRunning && !isCompleted && 'border-border/60'
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-muted/25',
            isRunning ? 'text-violet-500' : 'text-foreground/80'
          )}
        >
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-foreground/92">
              {displayName}
            </span>
            <Badge
              variant={isRunning ? 'default' : isError ? 'destructive' : 'secondary'}
              className={cn(
                'h-5 rounded-full px-2 text-[10px] font-medium',
                isRunning && 'bg-violet-500 animate-pulse'
              )}
            >
              {isRunning
                ? t('subAgent.working')
                : isError
                  ? t('subAgent.failed')
                  : t('subAgent.done')}
            </Badge>
          </div>

          {descriptionText ? (
            <p className="mt-1 line-clamp-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground/60">
              {descriptionText}
            </p>
          ) : null}

          {promptText ? (
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground/75">
              {promptText}
            </p>
          ) : null}
        </div>

        <button
          onClick={handleOpenPanel}
          className="rounded-full border border-border/60 p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          title={t('subAgent.viewDetails')}
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/60">
        {live || histMeta ? (
          <>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              {t('subAgent.iter', { count: live?.iteration ?? histMeta?.iterations ?? 0 })}
            </span>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              {t('subAgent.calls', {
                count: live?.toolCalls.length ?? histMeta?.toolCalls.length ?? 0
              })}
            </span>
          </>
        ) : null}
        {elapsed != null ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 tabular-nums">
            <Clock className="size-3" />
            {formatElapsed(elapsed)}
          </span>
        ) : null}
        {histMeta ? (
          <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 tabular-nums">
            {formatTokens(getBillableTotalTokens(histMeta.usage))} tok
          </span>
        ) : null}
      </div>

      <div className="mt-3 rounded-2xl border border-border/60 bg-muted/20 px-3 py-3">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
          {isRunning ? <Loader2 className="size-3 animate-spin" /> : <Brain className="size-3" />}
          <span>{isRunning ? t('subAgent.thinking') : t('subAgent.result')}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/88 line-clamp-5">
          {previewText ||
            (isRunning
              ? t('subAgent.exploring', { name: displayName })
              : t('subAgent.summaryEmpty', { defaultValue: '暂无摘要' }))}
        </p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground/55">
          {isRunning
            ? t('subAgent.openInRunsRunning', {
                defaultValue: '在右侧执行列表中查看实时进展'
              })
            : t('subAgent.openInRunsDone', {
                defaultValue: '在右侧执行列表中查看完整记录'
              })}
        </span>
        <button
          onClick={handleOpenPanel}
          className="text-xs font-medium text-violet-600 transition-colors hover:text-violet-500 dark:text-violet-400"
        >
          {t('subAgent.viewDetails')}
        </button>
      </div>
    </div>
  )
}
