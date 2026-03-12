import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
  ToolResultContent,
  ToolUseBlock,
  OpenAIComputerActionType,
  ToolCallExtraContent
} from './types'
import {
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_SCROLL_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  DESKTOP_WAIT_TOOL_NAME
} from '../app-plugin/types'
import { ipcStreamRequest, maskHeaders } from '../ipc/api-stream'
import { loadPrompt } from '../prompts/prompt-loader'
import { registerProvider } from './provider'

function resolveHeaderTemplate(value: string, config: ProviderConfig): string {
  return value
    .replace(/\{\{\s*sessionId\s*\}\}/g, config.sessionId ?? '')
    .replace(/\{\{\s*model\s*\}\}/g, config.model ?? '')
}

function applyHeaderOverrides(
  headers: Record<string, string>,
  config: ProviderConfig
): Record<string, string> {
  const overrides = config.requestOverrides?.headers
  if (!overrides) return headers
  for (const [key, rawValue] of Object.entries(overrides)) {
    const value = resolveHeaderTemplate(String(rawValue), config).trim()
    if (value) headers[key] = value
  }
  return headers
}

function applyBodyOverrides(body: Record<string, unknown>, config: ProviderConfig): void {
  const overrides = config.requestOverrides
  if (overrides?.body) {
    for (const [key, value] of Object.entries(overrides.body)) {
      body[key] = value
    }
  }
  if (overrides?.omitBodyKeys) {
    for (const key of overrides.omitBodyKeys) {
      delete body[key]
    }
  }
}

interface ComputerActionInputDescriptor {
  toolName: string
  input: Record<string, unknown>
  extraContent: ToolCallExtraContent
}

interface PendingComputerUseTurn {
  previousResponseId: string
  input: unknown[]
}

interface ComputerUseToolMeta {
  toolUseId: string
  toolName: string
  computerCallId: string
  computerActionType: OpenAIComputerActionType
  computerActionIndex: number
  autoAddedScreenshot?: boolean
}

class OpenAIResponsesProvider implements APIProvider {
  readonly name = 'OpenAI Responses'
  readonly type = 'openai-responses' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()
    let firstTokenAt: number | null = null
    let outputTokens = 0
    const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
    const pendingComputerTurn = config.computerUseEnabled
      ? this.extractPendingComputerUseTurn(messages)
      : null

    const body: Record<string, unknown> = {
      model: config.model,
      input: pendingComputerTurn
        ? pendingComputerTurn.input
        : this.formatMessages(messages, config.systemPrompt, !!config.thinkingEnabled),
      stream: true
    }

    if (pendingComputerTurn) {
      body.previous_response_id = pendingComputerTurn.previousResponseId
    }

    if (config.sessionId) {
      body.prompt_cache_key = `opencowork-${config.sessionId}`
    }

    const formattedTools = this.buildToolsPayload(tools, config)
    if (formattedTools.length > 0) {
      body.tools = formattedTools
    }
    if (config.temperature !== undefined) body.temperature = config.temperature
    if (config.serviceTier) body.service_tier = config.serviceTier
    if (config.maxTokens) body.max_output_tokens = config.maxTokens

    if (config.thinkingEnabled && config.thinkingConfig) {
      Object.assign(body, config.thinkingConfig.bodyParams)

      const reasoning =
        typeof body.reasoning === 'object' && body.reasoning !== null
          ? { ...(body.reasoning as Record<string, unknown>) }
          : {}

      if (config.thinkingConfig.reasoningEffortLevels && config.reasoningEffort) {
        reasoning.effort = config.reasoningEffort
      }

      if (body.model !== 'gpt-5.3-codex-spark') {
        reasoning.summary = config.responseSummary ?? 'auto'
      }
      if (Object.keys(reasoning).length > 0) {
        body.reasoning = reasoning
      }

      const include = Array.isArray(body.include)
        ? (body.include as unknown[]).filter((item): item is string => typeof item === 'string')
        : []
      if (!include.includes('reasoning.encrypted_content')) {
        include.push('reasoning.encrypted_content')
      }
      body.include = include

      if (config.thinkingConfig.forceTemperature !== undefined) {
        body.temperature = config.thinkingConfig.forceTemperature
      }
    } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
      Object.assign(body, config.thinkingConfig.disabledBodyParams)
    }

    const overridesBody = config.requestOverrides?.body
    const hasInstructionsOverride =
      !!overridesBody && Object.prototype.hasOwnProperty.call(overridesBody, 'instructions')

    if (!hasInstructionsOverride && config.instructionsPrompt) {
      const instructions = await loadPrompt(config.instructionsPrompt)
      if (!instructions) {
        yield {
          type: 'error',
          error: {
            type: 'config_error',
            message: `Instructions prompt "${config.instructionsPrompt}" not found`
          }
        }
        return
      }
      body.instructions = instructions
    }

    applyBodyOverrides(body, config)

    const url = `${baseUrl}/responses`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    }
    if (config.userAgent) headers['User-Agent'] = config.userAgent
    if (config.serviceTier) headers.service_tier = config.serviceTier
    applyHeaderOverrides(headers, config)

    const bodyStr = JSON.stringify(body)

    yield {
      type: 'request_debug',
      debugInfo: {
        url,
        method: 'POST',
        headers: maskHeaders(headers),
        body: bodyStr,
        timestamp: Date.now()
      }
    }

    const argBuffers = new Map<string, string>()
    const emittedThinkingEncrypted = new Set<string>()
    const emittedComputerCallIds = new Set<string>()
    let emittedThinkingDelta = false

    const extractReasoningSummaryText = (summary: unknown): string => {
      if (typeof summary === 'string') return summary
      if (!Array.isArray(summary)) return ''
      return summary
        .map((part) => {
          if (typeof part === 'string') return part
          if (!part || typeof part !== 'object') return ''
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        })
        .join('')
    }

    const tryBuildThinkingDeltaEvent = (thinking: unknown): StreamEvent | null => {
      if (typeof thinking !== 'string' || !thinking) return null
      emittedThinkingDelta = true
      return { type: 'thinking_delta', thinking }
    }

    const tryBuildThinkingEncryptedEvent = (encryptedContent: unknown): StreamEvent | null => {
      if (typeof encryptedContent !== 'string') return null
      const trimmed = encryptedContent.trim()
      if (!trimmed || emittedThinkingEncrypted.has(trimmed)) return null
      emittedThinkingEncrypted.add(trimmed)
      return {
        type: 'thinking_encrypted',
        thinkingEncryptedContent: trimmed,
        thinkingEncryptedProvider: 'openai-responses'
      }
    }

    const transport = config.preferResponsesWebSocket ? 'websocket' : undefined
    for await (const sse of ipcStreamRequest({
      url,
      method: 'POST',
      headers,
      body: bodyStr,
      signal,
      useSystemProxy: config.useSystemProxy,
      providerId: config.providerId,
      providerBuiltinId: config.providerBuiltinId,
      transport
    })) {
      if (!sse.data || sse.data === '[DONE]') continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any
      try {
        data = JSON.parse(sse.data)
      } catch {
        continue
      }

      switch (sse.event) {
        case 'response.output_text.delta':
          if (firstTokenAt === null) firstTokenAt = Date.now()
          yield { type: 'text_delta', text: data.delta }
          break

        case 'response.reasoning_summary_text.delta': {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          const thinkingEvent = tryBuildThinkingDeltaEvent(data.delta)
          if (thinkingEvent) {
            yield thinkingEvent
          }
          break
        }

        case 'response.reasoning_summary_text.done': {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          if (!emittedThinkingDelta) {
            const thinkingEvent = tryBuildThinkingDeltaEvent(
              data.text ?? data.delta ?? extractReasoningSummaryText(data.summary)
            )
            if (thinkingEvent) {
              yield thinkingEvent
            }
          }
          break
        }

        case 'response.output_item.added':
          if (data.item?.type === 'function_call') {
            argBuffers.set(data.item.id, '')
            yield {
              type: 'tool_call_start',
              toolCallId: data.item.call_id,
              toolName: data.item.name
            }
          } else if (data.item?.type === 'computer_call') {
            for (const event of this.buildComputerUseToolEvents(
              data.item,
              emittedComputerCallIds
            )) {
              yield event
            }
          } else if (data.item?.type === 'reasoning') {
            const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
              data.item.encrypted_content ?? data.item.reasoning?.encrypted_content
            )
            if (thinkingEncryptedEvent) {
              yield thinkingEncryptedEvent
            }
          }
          break

        case 'response.output_item.done': {
          if (data.item?.type === 'computer_call') {
            for (const event of this.buildComputerUseToolEvents(
              data.item,
              emittedComputerCallIds
            )) {
              yield event
            }
          }

          if (firstTokenAt === null) firstTokenAt = Date.now()
          if (!emittedThinkingDelta) {
            const thinkingEvent = tryBuildThinkingDeltaEvent(
              extractReasoningSummaryText(data.item?.summary ?? data.item?.reasoning?.summary)
            )
            if (thinkingEvent) {
              yield thinkingEvent
            }
          }

          const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
            data.item?.encrypted_content ?? data.item?.reasoning?.encrypted_content
          )
          if (thinkingEncryptedEvent) {
            yield thinkingEncryptedEvent
          }
          break
        }

        case 'response.function_call_arguments.delta': {
          yield { type: 'tool_call_delta', toolCallId: data.call_id, argumentsDelta: data.delta }
          const key = data.item_id
          argBuffers.set(key, (argBuffers.get(key) ?? '') + data.delta)
          break
        }

        case 'response.function_call_arguments.done':
          try {
            yield {
              type: 'tool_call_end',
              toolCallId: data.call_id,
              toolName: data.name,
              toolCallInput: JSON.parse(data.arguments)
            }
          } catch {
            yield {
              type: 'tool_call_end',
              toolCallId: data.call_id,
              toolName: data.name,
              toolCallInput: {}
            }
          }
          break

        case 'response.completed': {
          const requestCompletedAt = Date.now()
          const responseOutput = data.response?.output
          if (Array.isArray(responseOutput)) {
            for (const item of responseOutput) {
              if (item?.type === 'computer_call') {
                for (const event of this.buildComputerUseToolEvents(item, emittedComputerCallIds)) {
                  yield event
                }
              }

              if (!emittedThinkingDelta) {
                const thinkingEvent = tryBuildThinkingDeltaEvent(
                  extractReasoningSummaryText(item?.summary ?? item?.reasoning?.summary)
                )
                if (thinkingEvent) {
                  if (firstTokenAt === null) firstTokenAt = Date.now()
                  yield thinkingEvent
                }
              }

              const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
                item?.encrypted_content ?? item?.reasoning?.encrypted_content
              )
              if (thinkingEncryptedEvent) {
                yield thinkingEncryptedEvent
              }
            }
          }
          if (data.response?.usage?.output_tokens !== undefined) {
            outputTokens = data.response.usage.output_tokens ?? outputTokens
          }
          const cachedTokens = data.response?.usage?.input_tokens_details?.cached_tokens ?? 0
          const rawInputTokens = data.response?.usage?.input_tokens ?? 0
          yield {
            type: 'message_end',
            stopReason: data.response.status,
            providerResponseId: data.response?.id,
            usage: data.response.usage
              ? {
                  inputTokens: rawInputTokens,
                  outputTokens: data.response.usage.output_tokens ?? 0,
                  contextTokens: rawInputTokens,
                  ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
                  ...(data.response.usage.output_tokens_details?.reasoning_tokens
                    ? {
                        reasoningTokens: data.response.usage.output_tokens_details.reasoning_tokens
                      }
                    : {})
                }
              : undefined,
            timing: {
              totalMs: requestCompletedAt - requestStartedAt,
              ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
              tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
            }
          }
          break
        }

        case 'response.failed':
        case 'error':
          yield { type: 'error', error: { type: 'api_error', message: JSON.stringify(data) } }
          break
      }
    }
  }

  formatMessages(
    messages: UnifiedMessage[],
    systemPrompt?: string,
    includeEncryptedReasoning = false
  ): unknown[] {
    const input: unknown[] = []

    if (systemPrompt) {
      input.push({ type: 'message', role: 'developer', content: systemPrompt })
    }

    for (const m of messages) {
      if (m.role === 'system') continue

      if (typeof m.content === 'string') {
        input.push({ type: 'message', role: m.role, content: m.content })
        continue
      }

      const blocks = m.content as ContentBlock[]

      if (m.role === 'user') {
        const hasImages = blocks.some((b) => b.type === 'image')
        if (hasImages) {
          const parts: unknown[] = []
          for (const b of blocks) {
            if (b.type === 'image') {
              const url =
                b.source.type === 'base64'
                  ? `data:${b.source.mediaType || 'image/png'};base64,${b.source.data}`
                  : b.source.url || ''
              parts.push({ type: 'input_image', image_url: url })
            } else if (b.type === 'text') {
              parts.push({ type: 'input_text', text: b.text })
            }
          }
          input.push({ type: 'message', role: 'user', content: parts })
          continue
        }
      }

      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            input.push({ type: 'message', role: m.role, content: block.text })
            break
          case 'thinking':
            if (
              includeEncryptedReasoning &&
              m.role === 'assistant' &&
              block.encryptedContent &&
              (block.encryptedContentProvider === 'openai-responses' ||
                !block.encryptedContentProvider)
            ) {
              input.push({
                type: 'reasoning',
                summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
                encrypted_content: block.encryptedContent
              })
            }
            break
          case 'tool_use':
            if (block.extraContent?.openaiResponses?.computerUse?.kind === 'computer_use') {
              break
            }
            input.push({
              type: 'function_call',
              call_id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
              status: 'completed'
            })
            break
          case 'tool_result': {
            if (this.isComputerUseToolResultBlock(block, messages, m.id)) {
              break
            }
            let output: string
            if (Array.isArray(block.content)) {
              const textParts = block.content
                .filter((cb) => cb.type === 'text')
                .map((cb) => (cb.type === 'text' ? cb.text : ''))
              const imageParts = block.content.filter((cb) => cb.type === 'image')
              output =
                [...textParts, ...imageParts.map(() => '[Image attached]')].join('\n') || '[Image]'
            } else {
              output = block.content
            }
            input.push({
              type: 'function_call_output',
              call_id: block.toolUseId,
              output
            })
            break
          }
        }
      }
    }

    return input
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: this.normalizeToolSchema(t.inputSchema),
      strict: false
    }))
  }

  private buildToolsPayload(tools: ToolDefinition[], config: ProviderConfig): unknown[] {
    const formattedTools = this.formatTools(tools)
    if (!config.computerUseEnabled) return formattedTools
    return [{ type: 'computer' }, ...formattedTools]
  }

  private buildComputerUseToolEvents(
    item: {
      call_id?: string
      actions?: Array<Record<string, unknown>>
    },
    emittedComputerCallIds: Set<string>
  ): StreamEvent[] {
    const callId = typeof item.call_id === 'string' ? item.call_id : null
    if (!callId || emittedComputerCallIds.has(callId)) return []
    emittedComputerCallIds.add(callId)

    const actions = Array.isArray(item.actions) ? item.actions : []
    const descriptors = this.mapComputerActionsToToolCalls(callId, actions)
    const events: StreamEvent[] = []

    for (const descriptor of descriptors) {
      const toolUseId = this.buildComputerToolUseId(
        callId,
        descriptor.extraContent.openaiResponses?.computerUse?.computerActionIndex ?? 0,
        descriptor.toolName,
        events.length
      )
      events.push({
        type: 'tool_call_start',
        toolCallId: toolUseId,
        toolName: descriptor.toolName,
        toolCallExtraContent: descriptor.extraContent
      })
      events.push({
        type: 'tool_call_end',
        toolCallId: toolUseId,
        toolName: descriptor.toolName,
        toolCallInput: descriptor.input,
        toolCallExtraContent: descriptor.extraContent
      })
    }

    return events
  }

  private mapComputerActionsToToolCalls(
    callId: string,
    actions: Array<Record<string, unknown>>
  ): ComputerActionInputDescriptor[] {
    const descriptors: ComputerActionInputDescriptor[] = []
    let sawScreenshot = false

    actions.forEach((action, index) => {
      const actionType = this.getComputerActionType(action.type)
      if (!actionType) return

      if (actionType === 'screenshot') {
        sawScreenshot = true
        descriptors.push({
          toolName: DESKTOP_SCREENSHOT_TOOL_NAME,
          input: {},
          extraContent: {
            openaiResponses: {
              computerUse: {
                kind: 'computer_use',
                computerCallId: callId,
                computerActionType: actionType,
                computerActionIndex: index
              }
            }
          }
        })
        return
      }

      descriptors.push(...this.mapComputerActionDescriptor(callId, actionType, action, index))
    })

    if (!sawScreenshot) {
      descriptors.push({
        toolName: DESKTOP_SCREENSHOT_TOOL_NAME,
        input: {},
        extraContent: {
          openaiResponses: {
            computerUse: {
              kind: 'computer_use',
              computerCallId: callId,
              computerActionType: 'screenshot',
              computerActionIndex: actions.length,
              autoAddedScreenshot: true
            }
          }
        }
      })
    }

    return descriptors
  }

  private mapComputerActionDescriptor(
    callId: string,
    actionType: Exclude<OpenAIComputerActionType, 'screenshot'>,
    action: Record<string, unknown>,
    index: number
  ): ComputerActionInputDescriptor[] {
    const computerUse = {
      kind: 'computer_use' as const,
      computerCallId: callId,
      computerActionType: actionType,
      computerActionIndex: index
    }

    if (actionType === 'click' || actionType === 'double_click') {
      return [
        {
          toolName: DESKTOP_CLICK_TOOL_NAME,
          input: {
            x: Number(action.x ?? 0),
            y: Number(action.y ?? 0),
            button: typeof action.button === 'string' ? action.button : 'left',
            action: actionType === 'double_click' ? 'double_click' : 'click'
          },
          extraContent: {
            openaiResponses: {
              computerUse
            }
          }
        }
      ]
    }

    if (actionType === 'scroll') {
      return [
        {
          toolName: DESKTOP_SCROLL_TOOL_NAME,
          input: {
            ...(typeof action.x === 'number' ? { x: action.x } : {}),
            ...(typeof action.y === 'number' ? { y: action.y } : {}),
            scrollX: Number(action.scrollX ?? 0),
            scrollY: Number(action.scrollY ?? 0)
          },
          extraContent: {
            openaiResponses: {
              computerUse
            }
          }
        }
      ]
    }

    if (actionType === 'type') {
      return [
        {
          toolName: DESKTOP_TYPE_TOOL_NAME,
          input: {
            text: typeof action.text === 'string' ? action.text : ''
          },
          extraContent: {
            openaiResponses: {
              computerUse
            }
          }
        }
      ]
    }

    if (actionType === 'wait') {
      return [
        {
          toolName: DESKTOP_WAIT_TOOL_NAME,
          input: { delayMs: 2000 },
          extraContent: {
            openaiResponses: {
              computerUse
            }
          }
        }
      ]
    }

    const keys = Array.isArray(action.keys)
      ? action.keys.filter((item): item is string => typeof item === 'string')
      : []
    if (keys.length === 0) {
      return []
    }

    const normalizedKeys = keys
      .map((key) => this.normalizeComputerKey(key))
      .filter((key): key is string => Boolean(key))

    if (normalizedKeys.length === 0) {
      return []
    }

    if (normalizedKeys.length === 1) {
      return [
        {
          toolName: DESKTOP_TYPE_TOOL_NAME,
          input: { key: normalizedKeys[0] },
          extraContent: {
            openaiResponses: {
              computerUse
            }
          }
        }
      ]
    }

    const modifiers = normalizedKeys.slice(0, -1)
    const mainKey = normalizedKeys[normalizedKeys.length - 1]
    const modifierSet = new Set(['Control', 'Meta', 'Alt', 'Shift'])
    if (modifiers.every((key) => modifierSet.has(key))) {
      return [
        {
          toolName: DESKTOP_TYPE_TOOL_NAME,
          input: { hotkey: [...modifiers, mainKey] },
          extraContent: {
            openaiResponses: {
              computerUse
            }
          }
        }
      ]
    }

    return normalizedKeys.map((key, keyIndex) => ({
      toolName: DESKTOP_TYPE_TOOL_NAME,
      input: { key },
      extraContent: {
        openaiResponses: {
          computerUse: {
            ...computerUse,
            computerActionIndex: index * 100 + keyIndex
          }
        }
      }
    }))
  }

  private getComputerActionType(value: unknown): OpenAIComputerActionType | null {
    switch (value) {
      case 'click':
      case 'double_click':
      case 'scroll':
      case 'keypress':
      case 'type':
      case 'wait':
      case 'screenshot':
        return value
      default:
        return null
    }
  }

  private normalizeComputerKey(key: string): string | null {
    const normalized = key.trim().toUpperCase()
    const map: Record<string, string> = {
      ENTER: 'Enter',
      TAB: 'Tab',
      ESCAPE: 'Escape',
      ESC: 'Escape',
      BACKSPACE: 'Backspace',
      DELETE: 'Delete',
      UP: 'ArrowUp',
      ARROWUP: 'ArrowUp',
      DOWN: 'ArrowDown',
      ARROWDOWN: 'ArrowDown',
      LEFT: 'ArrowLeft',
      ARROWLEFT: 'ArrowLeft',
      RIGHT: 'ArrowRight',
      ARROWRIGHT: 'ArrowRight',
      HOME: 'Home',
      END: 'End',
      PAGEUP: 'PageUp',
      PAGEDOWN: 'PageDown',
      SPACE: 'Space',
      CTRL: 'Control',
      CONTROL: 'Control',
      CMD: 'Meta',
      COMMAND: 'Meta',
      META: 'Meta',
      ALT: 'Alt',
      OPTION: 'Alt',
      SHIFT: 'Shift'
    }

    if (map[normalized]) return map[normalized]
    if (/^[A-Z0-9]$/.test(normalized)) return normalized
    const functionKey = normalized.match(/^F([1-9]|1[0-2])$/)
    if (functionKey) return `F${functionKey[1]}`
    return null
  }

  private buildComputerToolUseId(
    callId: string,
    actionIndex: number,
    toolName: string,
    suffix: number
  ): string {
    const safeToolName = toolName.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()
    return `${callId}__${actionIndex}__${safeToolName}__${suffix}`
  }

  private extractPendingComputerUseTurn(messages: UnifiedMessage[]): PendingComputerUseTurn | null {
    const lastMessage = messages.at(-1)
    const previousMessage = messages.at(-2)
    if (!lastMessage || !previousMessage) return null
    if (lastMessage.role !== 'user' || previousMessage.role !== 'assistant') return null
    if (!previousMessage.providerResponseId) return null
    if (!Array.isArray(previousMessage.content) || !Array.isArray(lastMessage.content)) return null

    const computerToolMetas = this.collectComputerToolMetas(previousMessage.content)
    if (computerToolMetas.length === 0) return null

    const toolMetaById = new Map(computerToolMetas.map((item) => [item.toolUseId, item]))
    const functionToolUseIds = new Set(
      previousMessage.content
        .filter(
          (block): block is ToolUseBlock =>
            block.type === 'tool_use' && !this.isComputerUseToolBlock(block)
        )
        .map((block) => block.id)
    )

    const functionOutputs: unknown[] = []
    const computerResults = lastMessage.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_result' }> => {
        if (block.type !== 'tool_result') return false
        if (functionToolUseIds.has(block.toolUseId)) {
          functionOutputs.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: this.stringifyToolResult(block.content)
          })
        }
        return toolMetaById.has(block.toolUseId)
      }
    )

    if (computerResults.length === 0) return null

    const screenshotMeta = [...computerToolMetas]
      .sort((a, b) => a.computerActionIndex - b.computerActionIndex)
      .reverse()
      .find((item) => item.toolName === DESKTOP_SCREENSHOT_TOOL_NAME)

    const screenshotResult = screenshotMeta
      ? computerResults.find((result) => result.toolUseId === screenshotMeta.toolUseId)
      : null

    const screenshotDataUrl = screenshotResult
      ? this.extractScreenshotDataUrlFromToolResult(screenshotResult.content)
      : null

    if (screenshotMeta && screenshotDataUrl) {
      return {
        previousResponseId: previousMessage.providerResponseId,
        input: [
          ...functionOutputs,
          {
            type: 'computer_call_output',
            call_id: screenshotMeta.computerCallId,
            output: {
              type: 'computer_screenshot',
              image_url: screenshotDataUrl,
              detail: 'original'
            }
          }
        ]
      }
    }

    const errorText = computerResults
      .map((result) => this.extractToolErrorText(result.content))
      .filter((item): item is string => Boolean(item))
      .join('\n')

    return {
      previousResponseId: previousMessage.providerResponseId,
      input: [
        ...functionOutputs,
        {
          type: 'message',
          role: 'user',
          content:
            errorText ||
            'Computer use could not capture a follow-up screenshot after executing the requested actions.'
        }
      ]
    }
  }

  private collectComputerToolMetas(blocks: ContentBlock[]): ComputerUseToolMeta[] {
    return blocks
      .filter((block): block is ToolUseBlock => this.isComputerUseToolBlock(block))
      .map((block) => ({
        toolUseId: block.id,
        toolName: block.name,
        computerCallId: block.extraContent!.openaiResponses!.computerUse!.computerCallId,
        computerActionType: block.extraContent!.openaiResponses!.computerUse!.computerActionType,
        computerActionIndex: block.extraContent!.openaiResponses!.computerUse!.computerActionIndex,
        autoAddedScreenshot: block.extraContent!.openaiResponses!.computerUse!.autoAddedScreenshot
      }))
  }

  private isComputerUseToolBlock(block: ContentBlock): block is ToolUseBlock {
    return (
      block.type === 'tool_use' &&
      block.extraContent?.openaiResponses?.computerUse?.kind === 'computer_use'
    )
  }

  private isComputerUseToolResultBlock(
    block: Extract<ContentBlock, { type: 'tool_result' }>,
    messages: UnifiedMessage[],
    currentMessageId: string
  ): boolean {
    const currentIndex = messages.findIndex((message) => message.id === currentMessageId)
    if (currentIndex <= 0) return false
    const previousMessage = messages[currentIndex - 1]
    if (!previousMessage || !Array.isArray(previousMessage.content)) return false
    return previousMessage.content.some(
      (candidate) =>
        candidate.type === 'tool_use' &&
        candidate.id === block.toolUseId &&
        candidate.extraContent?.openaiResponses?.computerUse?.kind === 'computer_use'
    )
  }

  private extractScreenshotDataUrlFromToolResult(content: ToolResultContent): string | null {
    if (!Array.isArray(content)) return null
    const imageBlock = content.find((block) => block.type === 'image')
    if (!imageBlock || imageBlock.type !== 'image') return null
    if (imageBlock.source.type === 'url' && imageBlock.source.url) {
      return imageBlock.source.url
    }
    if (imageBlock.source.type === 'base64' && imageBlock.source.data) {
      return `data:${imageBlock.source.mediaType || 'image/png'};base64,${imageBlock.source.data}`
    }
    return null
  }

  private stringifyToolResult(content: ToolResultContent): string {
    if (typeof content === 'string') return content
    const textParts = content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
    const imageParts = content.filter((block) => block.type === 'image')
    return [...textParts, ...imageParts.map(() => '[Image attached]')].join('\n') || '[Image]'
  }

  private extractToolErrorText(content: ToolResultContent): string | null {
    if (typeof content !== 'string') return null
    try {
      const parsed = JSON.parse(content) as { error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error
      }
    } catch {
      return content.trim() || null
    }
    return null
  }

  private normalizeToolSchema(schema: ToolDefinition['inputSchema']): Record<string, unknown> {
    if ('properties' in schema) return schema

    const mergedProperties: Record<string, unknown> = {}
    let requiredIntersection: string[] | null = null

    for (const variant of schema.oneOf) {
      for (const [key, value] of Object.entries(variant.properties ?? {})) {
        if (!(key in mergedProperties)) mergedProperties[key] = value
      }

      const required = variant.required ?? []
      if (requiredIntersection === null) {
        requiredIntersection = [...required]
      } else {
        requiredIntersection = requiredIntersection.filter((key) => required.includes(key))
      }
    }

    const normalized: Record<string, unknown> = {
      type: 'object',
      properties: mergedProperties,
      additionalProperties: false
    }

    if (requiredIntersection && requiredIntersection.length > 0) {
      normalized.required = requiredIntersection
    }

    return normalized
  }
}

function computeTps(
  outputTokens: number,
  firstTokenAt: number | null,
  completedAt: number
): number | undefined {
  if (!firstTokenAt || outputTokens <= 0) return undefined
  const durationMs = completedAt - firstTokenAt
  if (durationMs <= 0) return undefined
  return outputTokens / (durationMs / 1000)
}

export function registerOpenAIResponsesProvider(): void {
  registerProvider('openai-responses', () => new OpenAIResponsesProvider())
}
