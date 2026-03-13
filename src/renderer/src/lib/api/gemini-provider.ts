import type {
  APIProvider,
  ImageBlock,
  ImageErrorCode,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock
} from './types'
import { maskHeaders } from '../ipc/api-stream'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import { registerProvider } from './provider'

const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000

class GeminiImageRequestError extends Error {
  readonly code: ImageErrorCode
  readonly statusCode?: number

  constructor(message: string, options: { code: ImageErrorCode; statusCode?: number }) {
    super(message)
    this.name = 'GeminiImageRequestError'
    this.code = options.code
    this.statusCode = options.statusCode
  }
}

async function persistGeneratedImage(data: string, mediaType?: string): Promise<ImageBlock> {
  const fallback: ImageBlock = {
    type: 'image',
    source: {
      type: 'base64',
      mediaType: mediaType || 'image/png',
      data
    }
  }

  try {
    const result = (await ipcClient.invoke(IPC.IMAGE_PERSIST_GENERATED, {
      data,
      mediaType
    })) as {
      filePath?: string
      mediaType?: string
      data?: string
      error?: string
    }

    if (result?.error || !result?.data) {
      if (result?.error) {
        console.warn('[Gemini Provider] Failed to persist generated image:', result.error)
      }
      return fallback
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: result.mediaType || mediaType || 'image/png',
        data: result.data,
        filePath: result.filePath
      }
    }
  } catch (error) {
    console.warn('[Gemini Provider] Failed to persist generated image:', error)
    return fallback
  }
}

interface GeminiInlineData {
  mimeType?: string
  mime_type?: string
  data?: string
}

interface GeminiPart {
  text?: string
  inlineData?: GeminiInlineData
  inline_data?: GeminiInlineData
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[]
  }
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

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

function resolveBaseUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
    .trim()
    .replace(/\/+$/, '')
  return trimmed.replace(/\/openai$/i, '')
}

function extractTextPrompt(messages: UnifiedMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!lastUserMessage) return ''

  if (typeof lastUserMessage.content === 'string') {
    return lastUserMessage.content.trim()
  }

  const blocks = lastUserMessage.content as ContentBlock[]
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function extractGeneratedImages(data: GeminiGenerateContentResponse): Array<{
  data: string
  mediaType: string
}> {
  const images: Array<{ data: string; mediaType: string }> = []

  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inlineData = part.inlineData ?? part.inline_data
      if (!inlineData?.data) continue
      images.push({
        data: inlineData.data,
        mediaType: inlineData.mimeType || inlineData.mime_type || 'image/png'
      })
    }
  }

  return images
}

function extractResponseText(data: GeminiGenerateContentResponse): string {
  const chunks: string[] = []

  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text?.trim()) {
        chunks.push(part.text.trim())
      }
    }
  }

  return chunks.join('\n').trim()
}

function createRequestSignal(signal?: AbortSignal): {
  signal: AbortSignal
  didTimeout: () => boolean
  cleanup: () => void
} {
  const timeoutController = new AbortController()
  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const onParentAbort = (): void => {
    timeoutController.abort(signal?.reason)
  }

  if (signal?.aborted) {
    timeoutController.abort(signal.reason)
  } else {
    signal?.addEventListener('abort', onParentAbort, { once: true })
  }

  if (!timeoutController.signal.aborted) {
    timeoutId = setTimeout(() => {
      timedOut = true
      timeoutController.abort(new DOMException('Image request timed out', 'TimeoutError'))
    }, IMAGE_REQUEST_TIMEOUT_MS)
  }

  return {
    signal: timeoutController.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      signal?.removeEventListener('abort', onParentAbort)
    }
  }
}

function mapFetchError(error: unknown, didTimeout: boolean): GeminiImageRequestError {
  if (didTimeout) {
    return new GeminiImageRequestError('Gemini image request timed out after 10 minutes', {
      code: 'timeout'
    })
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new GeminiImageRequestError('Gemini image request was cancelled', {
      code: 'request_aborted'
    })
  }

  if (error instanceof TypeError) {
    return new GeminiImageRequestError(
      `Network request failed while generating Gemini image. Please check your network, proxy, and Base URL settings. (${error.message})`,
      { code: 'network' }
    )
  }

  if (error instanceof GeminiImageRequestError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  return new GeminiImageRequestError(message || 'Unknown Gemini image request error', {
    code: 'unknown'
  })
}

function normalizeGeminiError(error: unknown): { code: ImageErrorCode; message: string } {
  const normalized = mapFetchError(error, false)
  return {
    code: normalized.code,
    message: normalized.message
  }
}

class GeminiProvider implements APIProvider {
  readonly name = 'Gemini Image Generation'
  readonly type = 'gemini' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    _tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()

    try {
      yield { type: 'message_start' }

      if (!config.apiKey) {
        throw new GeminiImageRequestError('Missing API key for Gemini image request', {
          code: 'api_error'
        })
      }

      const prompt = extractTextPrompt(messages)
      if (!prompt) {
        throw new GeminiImageRequestError('No prompt provided for Gemini image generation', {
          code: 'api_error'
        })
      }

      const generationConfig: Record<string, unknown> = {
        responseModalities: ['IMAGE']
      }
      if (config.temperature !== undefined) {
        generationConfig.temperature = config.temperature
      }
      if (config.maxTokens) {
        generationConfig.maxOutputTokens = config.maxTokens
      }

      const body: Record<string, unknown> = {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig
      }

      if (config.systemPrompt?.trim()) {
        body.systemInstruction = {
          parts: [{ text: config.systemPrompt.trim() }]
        }
      }

      applyBodyOverrides(body, config)

      const url = `${resolveBaseUrl(config.baseUrl)}/models/${encodeURIComponent(config.model)}:generateContent`
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
        Authorization: `Bearer ${config.apiKey}`
      }
      if (config.userAgent) headers['User-Agent'] = config.userAgent
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

      const requestSignal = createRequestSignal(signal)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: bodyStr,
          signal: requestSignal.signal
        })
      } catch (error) {
        throw mapFetchError(error, requestSignal.didTimeout())
      } finally {
        requestSignal.cleanup()
      }

      if (!response.ok) {
        let errorMessage = `Gemini image generation failed: ${response.status}`
        try {
          const errorData = (await response.json()) as {
            error?: { message?: string }
            message?: string
          }
          if (errorData.error?.message) {
            errorMessage = errorData.error.message
          } else if (errorData.message) {
            errorMessage = errorData.message
          } else {
            errorMessage = JSON.stringify(errorData)
          }
        } catch {
          const errorText = await response.text().catch(() => 'Unknown error')
          errorMessage = errorText
        }
        throw new GeminiImageRequestError(errorMessage, {
          code: 'api_error',
          statusCode: response.status
        })
      }

      const data = (await response.json()) as GeminiGenerateContentResponse
      const images = extractGeneratedImages(data)

      if (images.length === 0) {
        const responseText = extractResponseText(data)
        throw new GeminiImageRequestError(
          responseText
            ? `Gemini returned no image output. ${responseText}`
            : 'Gemini returned no image output',
          {
            code: 'api_error'
          }
        )
      }

      for (const image of images) {
        const imageBlock = await persistGeneratedImage(image.data, image.mediaType)
        yield {
          type: 'image_generated',
          imageBlock
        }
      }

      const usageMetadata = data.usageMetadata
      const requestCompletedAt = Date.now()
      const promptTokenCount = usageMetadata?.promptTokenCount ?? 0
      const outputTokens =
        usageMetadata?.candidatesTokenCount ??
        Math.max((usageMetadata?.totalTokenCount ?? 0) - promptTokenCount, 0)

      yield {
        type: 'message_end',
        stopReason: 'stop',
        ...(usageMetadata
          ? {
              usage: {
                inputTokens: promptTokenCount,
                outputTokens
              }
            }
          : {}),
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: requestCompletedAt - requestStartedAt
        }
      }
    } catch (error) {
      const normalizedError = normalizeGeminiError(error)
      console.error('[Gemini Provider] Error:', normalizedError.message, error)

      yield {
        type: 'image_error',
        imageError: {
          code: normalizedError.code,
          message: normalizedError.message
        }
      }

      const requestCompletedAt = Date.now()
      yield {
        type: 'message_end',
        stopReason: 'error',
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: requestCompletedAt - requestStartedAt
        }
      }

      return
    }
  }

  formatMessages(messages: UnifiedMessage[]): unknown {
    void messages
    return []
  }

  formatTools(tools: ToolDefinition[]): unknown {
    void tools
    return []
  }
}

export function registerGeminiProvider(): void {
  registerProvider('gemini', () => new GeminiProvider())
}
