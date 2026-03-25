import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { AIModelConfig, RequestDebugInfo, RequestTiming, TokenUsage } from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'

export interface UsageAnalyticsQuery {
  from: number
  to: number
  providerId?: string | null
  modelId?: string | null
  sourceKind?: string | null
  limit?: number
  offset?: number
}

export interface UsageAnalyticsOverview {
  request_count: number
  input_tokens: number
  billable_input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
  total_cost_usd: number
  avg_ttft_ms: number | null
  avg_total_ms: number | null
}

export interface UsageAnalyticsGroupRow {
  [key: string]: unknown
}

function toNullableNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function computeCosts(usage: TokenUsage, modelConfig: AIModelConfig | null): {
  inputPrice: number | null
  outputPrice: number | null
  cacheCreationPrice: number | null
  cacheHitPrice: number | null
  inputCostUsd: number | null
  outputCostUsd: number | null
  cacheCreationCostUsd: number | null
  cacheHitCostUsd: number | null
  totalCostUsd: number | null
} {
  const billableInput = usage.billableInputTokens ?? usage.inputTokens
  const inputPrice = toNullableNumber(modelConfig?.inputPrice)
  const outputPrice = toNullableNumber(modelConfig?.outputPrice)
  const cacheCreationPrice = toNullableNumber(modelConfig?.cacheCreationPrice)
  const cacheHitPrice = toNullableNumber(modelConfig?.cacheHitPrice)

  const inputCostUsd = inputPrice == null ? null : (billableInput * inputPrice) / 1_000_000
  const outputCostUsd =
    outputPrice == null ? null : ((usage.outputTokens ?? 0) * outputPrice) / 1_000_000
  const cacheCreationCostUsd =
    cacheCreationPrice == null
      ? null
      : (((usage.cacheCreationTokens ?? 0) * cacheCreationPrice) / 1_000_000)
  const cacheHitCostUsd =
    cacheHitPrice == null ? null : (((usage.cacheReadTokens ?? 0) * cacheHitPrice) / 1_000_000)

  const costs = [inputCostUsd, outputCostUsd, cacheCreationCostUsd, cacheHitCostUsd]
  const totalCostUsd = costs.every((item) => item == null)
    ? null
    : costs.reduce<number>((sum, item) => sum + (item ?? 0), 0)

  return {
    inputPrice,
    outputPrice,
    cacheCreationPrice,
    cacheHitPrice,
    inputCostUsd,
    outputCostUsd,
    cacheCreationCostUsd,
    cacheHitCostUsd,
    totalCostUsd
  }
}

export async function recordUsageEvent(input: {
  sessionId?: string | null
  messageId?: string | null
  sourceKind: string
  providerId?: string | null
  modelId?: string | null
  usage?: TokenUsage
  timing?: RequestTiming
  debugInfo?: RequestDebugInfo
  providerResponseId?: string
  meta?: Record<string, unknown>
  createdAt?: number
}): Promise<void> {
  if (!input.usage && !input.timing) return

  const chatStore = useChatStore.getState()
  const providerStore = useProviderStore.getState()
  const session = input.sessionId
    ? chatStore.sessions.find((item) => item.id === input.sessionId)
    : undefined
  const providerId = input.providerId ?? session?.providerId ?? null
  const modelId = input.modelId ?? session?.modelId ?? null
  const provider = providerId ? providerStore.providers.find((item) => item.id === providerId) : null
  const model = modelId ? provider?.models.find((item) => item.id === modelId) ?? null : null
  const usage = input.usage ?? {
    inputTokens: 0,
    outputTokens: 0
  }
  const costs = computeCosts(usage, model)
  const createdAt = input.createdAt ?? Date.now()

  await ipcClient.invoke(IPC.USAGE_EVENTS_ADD, {
    id: nanoid(),
    created_at: createdAt,
    request_started_at:
      input.timing && typeof input.timing.totalMs === 'number' ? createdAt - input.timing.totalMs : null,
    request_finished_at: createdAt,
    session_id: input.sessionId ?? null,
    message_id: input.messageId ?? null,
    project_id: session?.projectId ?? null,
    source_kind: input.sourceKind,
    provider_id: providerId,
    provider_name: provider?.name ?? null,
    provider_type: provider?.type ?? null,
    provider_builtin_id: provider?.builtinId ?? null,
    provider_base_url: provider?.baseUrl ?? null,
    model_id: modelId,
    model_name: model?.name ?? modelId ?? null,
    model_category: model?.category ?? null,
    request_type: model?.type ?? provider?.type ?? null,
    input_tokens: usage.inputTokens ?? 0,
    billable_input_tokens: usage.billableInputTokens ?? null,
    output_tokens: usage.outputTokens ?? 0,
    cache_creation_tokens: usage.cacheCreationTokens ?? null,
    cache_read_tokens: usage.cacheReadTokens ?? null,
    reasoning_tokens: usage.reasoningTokens ?? null,
    context_tokens: usage.contextTokens ?? null,
    input_price: costs.inputPrice,
    output_price: costs.outputPrice,
    cache_creation_price: costs.cacheCreationPrice,
    cache_hit_price: costs.cacheHitPrice,
    input_cost_usd: costs.inputCostUsd,
    output_cost_usd: costs.outputCostUsd,
    cache_creation_cost_usd: costs.cacheCreationCostUsd,
    cache_hit_cost_usd: costs.cacheHitCostUsd,
    total_cost_usd: costs.totalCostUsd,
    ttft_ms: input.timing?.ttftMs ?? null,
    total_ms: input.timing?.totalMs ?? null,
    tps: input.timing?.tps ?? null,
    provider_response_id: input.providerResponseId ?? null,
    request_debug_json: input.debugInfo ? JSON.stringify(input.debugInfo) : null,
    usage_raw_json: input.usage ? JSON.stringify(input.usage) : null,
    meta_json: input.meta ? JSON.stringify(input.meta) : null
  })
}

export function getUsageOverview(query: UsageAnalyticsQuery): Promise<UsageAnalyticsOverview> {
  return ipcClient.invoke(IPC.USAGE_EVENTS_OVERVIEW, query) as Promise<UsageAnalyticsOverview>
}

export function getUsageDaily(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return ipcClient.invoke(IPC.USAGE_EVENTS_DAILY, query) as Promise<UsageAnalyticsGroupRow[]>
}

export function getUsageByModel(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return ipcClient.invoke(IPC.USAGE_EVENTS_BY_MODEL, query) as Promise<UsageAnalyticsGroupRow[]>
}

export function getUsageByProvider(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return ipcClient.invoke(IPC.USAGE_EVENTS_BY_PROVIDER, query) as Promise<UsageAnalyticsGroupRow[]>
}

export function listUsageEvents(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return ipcClient.invoke(IPC.USAGE_EVENTS_LIST, query) as Promise<UsageAnalyticsGroupRow[]>
}
