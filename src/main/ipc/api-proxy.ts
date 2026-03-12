import { ipcMain, BrowserWindow, net, session } from 'electron'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { WebSocket } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

interface APIStreamRequest {
  requestId: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  useSystemProxy?: boolean
  providerId?: string
  providerBuiltinId?: string
  transport?: 'http' | 'websocket'
}

function readTimeoutFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallbackMs
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackMs
  return Math.floor(parsed)
}

function cancelNetRequest(req: Electron.ClientRequest): void {
  const anyReq = req as unknown as { abort?: () => void; destroy?: (err?: Error) => void }
  if (typeof anyReq.abort === 'function') {
    anyReq.abort()
    return
  }
  if (typeof anyReq.destroy === 'function') {
    anyReq.destroy()
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    const str = String(value)
    if (!str) continue
    if (/\r|\n/.test(str)) continue
    sanitized[key] = str
  }
  return sanitized
}

interface CodexQuotaWindow {
  usedPercent?: number
  windowMinutes?: number
  resetAt?: string
  resetAfterSeconds?: number
}

interface CodexQuota {
  type: 'codex'
  planType?: string
  primary?: CodexQuotaWindow
  secondary?: CodexQuotaWindow
  primaryOverSecondaryLimitPercent?: number
  credits?: {
    hasCredits?: boolean
    balance?: number
    unlimited?: boolean
  }
  fetchedAt: number
}

function normalizeHeaderMap(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      if (value[0]) normalized[key.toLowerCase()] = value[0]
      continue
    }
    if (typeof value === 'string' && value) {
      normalized[key.toLowerCase()] = value
    }
  }
  return normalized
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function parseBoolean(value?: string): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  return undefined
}

function extractCodexQuota(
  headers: Record<string, string | string[] | undefined>
): CodexQuota | null {
  const normalized = normalizeHeaderMap(headers)
  const hasCodexHeaders = Object.keys(normalized).some((key) => key.startsWith('x-codex-'))
  if (!hasCodexHeaders) return null

  const primary: CodexQuotaWindow = {
    usedPercent: parseNumber(normalized['x-codex-primary-used-percent']),
    windowMinutes: parseNumber(normalized['x-codex-primary-window-minutes']),
    resetAt: normalized['x-codex-primary-reset-at'],
    resetAfterSeconds: parseNumber(normalized['x-codex-primary-reset-after-seconds'])
  }
  const secondary: CodexQuotaWindow = {
    usedPercent: parseNumber(normalized['x-codex-secondary-used-percent']),
    windowMinutes: parseNumber(normalized['x-codex-secondary-window-minutes']),
    resetAt: normalized['x-codex-secondary-reset-at'],
    resetAfterSeconds: parseNumber(normalized['x-codex-secondary-reset-after-seconds'])
  }

  const credits = {
    hasCredits: parseBoolean(normalized['x-codex-credits-has-credits']),
    balance: parseNumber(normalized['x-codex-credits-balance']),
    unlimited: parseBoolean(normalized['x-codex-credits-unlimited'])
  }

  return {
    type: 'codex',
    planType: normalized['x-codex-plan-type'],
    primary: Object.values(primary).some((v) => v !== undefined) ? primary : undefined,
    secondary: Object.values(secondary).some((v) => v !== undefined) ? secondary : undefined,
    primaryOverSecondaryLimitPercent: parseNumber(
      normalized['x-codex-primary-over-secondary-limit-percent']
    ),
    credits: Object.values(credits).some((v) => v !== undefined) ? credits : undefined,
    fetchedAt: Date.now()
  }
}

function sendQuotaUpdate(
  event: Electron.IpcMainEvent,
  req: Pick<APIStreamRequest, 'requestId' | 'url' | 'providerId' | 'providerBuiltinId'>,
  headers: Record<string, string | string[] | undefined>
): void {
  const quota = extractCodexQuota(headers)
  if (!quota) return
  const sender = getSender(event)
  if (!sender) return
  sender.send('api:quota-update', {
    requestId: req.requestId,
    url: req.url,
    providerId: req.providerId,
    providerBuiltinId: req.providerBuiltinId,
    quota
  })
}

function requestViaSystemProxy(args: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}): Promise<{
  statusCode?: number
  error?: string
  body?: string
  headers?: Record<string, string | string[] | undefined>
}> {
  const { url, method, headers, body } = args
  const requestUrl = url.trim()
  const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
  const reqHeaders = sanitizeHeaders({ ...headers })

  return new Promise((resolve) => {
    let done = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (payload: {
      statusCode?: number
      error?: string
      body?: string
      headers?: Record<string, string | string[] | undefined>
    }): void => {
      if (done) return
      done = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      resolve(payload)
    }

    const httpReq = net.request({ method, url: requestUrl })
    for (const [key, value] of Object.entries(reqHeaders)) {
      httpReq.setHeader(key, value)
    }

    httpReq.on('response', (res) => {
      let responseBody = ''
      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString()
      })
      res.on('end', () => {
        finish({
          statusCode: res.statusCode,
          body: responseBody,
          headers: res.headers as Record<string, string | string[] | undefined>
        })
      })
    })

    httpReq.on('error', (err) => {
      finish({ statusCode: 0, error: err.message })
    })

    timeout = setTimeout(() => {
      cancelNetRequest(httpReq)
      finish({ statusCode: 0, error: 'Request timed out (15s)' })
    }, 15000)

    if (bodyBuffer) httpReq.write(bodyBuffer)
    httpReq.end()
  })
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return parsed.toString()
}

function encodeSseEvent(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`
}

function parseProxyResult(
  result: string
): string | null {
  const s = result.trim().toUpperCase()
  if (!s || s === 'DIRECT') return null
  const m = s.match(/^(?:PROXY|HTTPS)\s+([^\s]+)$/i)
  if (!m) return null
  const hostPort = m[1].trim()
  if (!hostPort) return null
  return hostPort.startsWith('http') ? hostPort : `http://${hostPort}`
}

async function streamViaResponsesWebSocket(
  event: Electron.IpcMainEvent,
  req: APIStreamRequest
): Promise<void> {
  const { requestId, url, headers, body, useSystemProxy } = req
  const sender = getSender(event)
  if (!sender) return

  let requestBody: Record<string, unknown>
  try {
    requestBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
  } catch {
    sender.send('api:stream-error', {
      requestId,
      error: 'Invalid WebSocket request body'
    })
    return
  }

  delete requestBody.stream
  delete requestBody.background

  const wsUrl = toWebSocketUrl(url)
  const wsHeaders = sanitizeHeaders({ ...headers })
  delete wsHeaders['Content-Type']
  delete wsHeaders['content-type']

  let agent: InstanceType<typeof HttpsProxyAgent> | undefined
  if (useSystemProxy) {
    try {
      const result = await session.defaultSession.resolveProxy(wsUrl)
      const proxyUrl = parseProxyResult(result)
      if (proxyUrl) {
        agent = new HttpsProxyAgent(proxyUrl)
      }
    } catch (err) {
      console.warn('[API Proxy] WebSocket resolveProxy failed, connecting direct:', err)
    }
  }

  const CONNECTION_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_CONNECTION_TIMEOUT_MS', 30_000)
  const IDLE_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_IDLE_TIMEOUT_MS', 300_000)

  let settled = false
  let finished = false
  let aborted = false
  let connectionTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (connectionTimer) {
      clearTimeout(connectionTimer)
      connectionTimer = null
    }
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  let socket: WebSocket
  const resetIdleTimer = (): void => {
    if (IDLE_TIMEOUT <= 0 || settled) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      socket.close(4000, 'idle timeout')
    }, IDLE_TIMEOUT)
  }

  const complete = (): void => {
    if (settled) return
    settled = true
    clearTimers()
    sender.send('api:stream-end', { requestId })
  }

  const fail = (message: string): void => {
    if (settled) return
    settled = true
    clearTimers()
    sender.send('api:stream-error', {
      requestId,
      error: message
    })
  }

  socket = new WebSocket(wsUrl, {
    headers: wsHeaders,
    handshakeTimeout: CONNECTION_TIMEOUT,
    perMessageDeflate: false,
    ...(agent ? { agent } : {})
  })

  if (CONNECTION_TIMEOUT > 0) {
    connectionTimer = setTimeout(() => {
      socket.close(4000, 'connection timeout')
    }, CONNECTION_TIMEOUT)
  }

  socket.on('open', () => {
    if (connectionTimer) {
      clearTimeout(connectionTimer)
      connectionTimer = null
    }
    resetIdleTimer()
    socket.send(
      JSON.stringify({
        type: 'response.create',
        ...requestBody
      }),
      (err) => {
        if (err) {
          fail(err.message)
        }
      }
    )
  })

  socket.on('message', (raw) => {
    resetIdleTimer()
    let payload: unknown
    try {
      payload = JSON.parse(raw.toString())
    } catch {
      return
    }

    const eventType =
      typeof payload === 'object' &&
      payload !== null &&
      'type' in payload &&
      typeof (payload as { type?: unknown }).type === 'string'
        ? (payload as { type: string }).type
        : 'message'

    sender.send('api:stream-chunk', {
      requestId,
      data: encodeSseEvent(eventType, payload)
    })

    if (
      eventType === 'response.completed' ||
      eventType === 'response.failed' ||
      eventType === 'response.incomplete' ||
      eventType === 'response.cancelled' ||
      eventType === 'error'
    ) {
      finished = true
      socket.close()
    }
  })

  socket.on('unexpected-response', (_request, response) => {
    fail(`WebSocket handshake failed: HTTP ${response.statusCode ?? 0}`)
  })

  socket.on('error', (err) => {
    if (aborted) return
    fail(err.message)
  })

  socket.on('close', (code, reason) => {
    clearTimers()
    ipcMain.removeListener('api:abort', abortHandler)
    if (settled) return
    if (aborted || finished) {
      complete()
      return
    }
    const reasonText = reason.toString().trim()
    fail(`WebSocket closed (${code})${reasonText ? `: ${reasonText}` : ''}`)
  })

  const abortHandler = (_event: Electron.IpcMainEvent, data: { requestId: string }): void => {
    if (data.requestId !== requestId) return
    aborted = true
    socket.close()
  }

  ipcMain.on('api:abort', abortHandler)
}

export function registerApiProxyHandlers(): void {
  // Handle non-streaming API requests (e.g., test connection)
  ipcMain.handle('api:request', async (event, req: Omit<APIStreamRequest, 'requestId'>) => {
    const { url, method, headers, body, useSystemProxy, providerId, providerBuiltinId } = req
    try {
      console.log(`[API Proxy] request ${method} ${url}`)
      if (useSystemProxy) {
        const result = await requestViaSystemProxy({ url, method, headers, body })
        if ((providerId || providerBuiltinId) && result.headers) {
          const quota = extractCodexQuota(result.headers)
          if (quota && event.sender) {
            event.sender.send('api:quota-update', {
              url,
              providerId,
              providerBuiltinId,
              quota
            })
          }
        }
        return { statusCode: result.statusCode, body: result.body, error: result.error }
      }
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
      const reqHeaders = { ...headers }
      if (bodyBuffer) {
        reqHeaders['Content-Length'] = String(bodyBuffer.byteLength)
      }

      return new Promise((resolve) => {
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers: reqHeaders
        }

        const httpReq = httpModule.request(options, (res) => {
          let responseBody = ''
          res.on('data', (chunk: Buffer) => {
            responseBody += chunk.toString()
          })
          res.on('end', () => {
            if (providerId || providerBuiltinId) {
              const quota = extractCodexQuota(
                res.headers as Record<string, string | string[] | undefined>
              )
              if (quota && event.sender) {
                event.sender.send('api:quota-update', {
                  url,
                  providerId,
                  providerBuiltinId,
                  quota
                })
              }
            }
            resolve({ statusCode: res.statusCode, body: responseBody })
          })
        })

        httpReq.on('error', (err) => {
          console.error(`[API Proxy] request error: ${err.message}`)
          resolve({ statusCode: 0, error: err.message })
        })

        httpReq.setTimeout(15000, () => {
          httpReq.destroy()
          resolve({ statusCode: 0, error: 'Request timed out (15s)' })
        })

        if (bodyBuffer) httpReq.write(bodyBuffer)
        httpReq.end()
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[API Proxy] request fatal error: ${errMsg}`)
      return { statusCode: 0, error: errMsg }
    }
  })

  // Handle streaming API requests from renderer
  ipcMain.on('api:stream-request', (event, req: APIStreamRequest) => {
    const {
      requestId,
      url,
      method,
      headers,
      body,
      useSystemProxy,
      providerId,
      providerBuiltinId,
      transport
    } = req

    try {
      console.log(`[API Proxy] stream-request[${requestId}] ${method} ${url}`)
      if (transport === 'websocket') {
        void streamViaResponsesWebSocket(event, req).catch((err) => {
          console.error('[API Proxy] WebSocket stream error:', err)
        })
        return
      }
      if (useSystemProxy) {
        const requestUrl = url.trim()
        const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
        const reqHeaders = sanitizeHeaders({ ...headers })

        // Timeouts (ms):
        // - Connection: max wait for the server to start responding (first byte)
        // - Idle: max gap between consecutive data chunks during streaming
        const CONNECTION_TIMEOUT = readTimeoutFromEnv(
          'OPENCOWORK_API_CONNECTION_TIMEOUT_MS',
          180_000
        )
        const IDLE_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_IDLE_TIMEOUT_MS', 300_000)
        let idleTimer: ReturnType<typeof setTimeout> | null = null

        const clearIdleTimer = (): void => {
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
        }

        const resetIdleTimer = (req: Electron.ClientRequest): void => {
          if (IDLE_TIMEOUT <= 0) return
          clearIdleTimer()
          idleTimer = setTimeout(() => {
            console.warn(`[API Proxy] Idle timeout (${IDLE_TIMEOUT}ms) for ${requestId}`)
            cancelNetRequest(req)
          }, IDLE_TIMEOUT)
        }

        const httpReq = net.request({ method, url: requestUrl })
        for (const [key, value] of Object.entries(reqHeaders)) {
          httpReq.setHeader(key, value)
        }
        let connectionTimer: ReturnType<typeof setTimeout> | null = null

        const clearConnectionTimer = (): void => {
          if (connectionTimer) {
            clearTimeout(connectionTimer)
            connectionTimer = null
          }
        }

        httpReq.on('response', (res) => {
          clearConnectionTimer()
          const statusCode = res.statusCode || 0
          sendQuotaUpdate(
            event,
            { requestId, url, providerId, providerBuiltinId },
            res.headers ?? {}
          )

          // For non-2xx, collect full body and send as error
          if (statusCode < 200 || statusCode >= 300) {
            clearIdleTimer()
            let errorBody = ''
            res.on('data', (chunk: Buffer) => {
              if (errorBody.length < 4000) errorBody += chunk.toString()
            })
            res.on('end', () => {
              console.error(
                `[API Proxy] stream-request[${requestId}] HTTP ${statusCode}: ${errorBody.slice(0, 500)}`
              )
              const sender = getSender(event)
              if (sender) {
                sender.send('api:stream-error', {
                  requestId,
                  error: `HTTP ${statusCode}: ${errorBody.slice(0, 2000)}`
                })
              }
            })
            return
          }

          // Stream SSE chunks to renderer
          res.on('data', (chunk: Buffer) => {
            resetIdleTimer(httpReq)
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-chunk', {
                requestId,
                data: chunk.toString()
              })
            }
          })

          res.on('end', () => {
            clearIdleTimer()
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-end', { requestId })
            }
          })

          res.on('error', (err) => {
            clearIdleTimer()
            console.error(`[API Proxy] stream-request[${requestId}] response error: ${err.message}`)
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-error', {
                requestId,
                error: err.message
              })
            }
          })
        })

        // Connection timeout: abort if the server doesn't respond at all
        if (CONNECTION_TIMEOUT > 0) {
          connectionTimer = setTimeout(() => {
            console.warn(
              `[API Proxy] Connection timeout (${CONNECTION_TIMEOUT}ms) for ${requestId}`
            )
            cancelNetRequest(httpReq)
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-error', {
                requestId,
                error: `Connection timeout (${CONNECTION_TIMEOUT / 1000}s)`
              })
            }
          }, CONNECTION_TIMEOUT)
        }

        httpReq.on('error', (err) => {
          clearConnectionTimer()
          clearIdleTimer()
          console.error(`[API Proxy] stream-request[${requestId}] request error: ${err.message}`)
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-error', {
              requestId,
              error: err.message
            })
          }
        })

        // Handle abort from renderer
        const abortHandler = (_event: Electron.IpcMainEvent, data: { requestId: string }): void => {
          if (data.requestId === requestId) {
            clearConnectionTimer()
            clearIdleTimer()
            cancelNetRequest(httpReq)
            ipcMain.removeListener('api:abort', abortHandler)
          }
        }
        ipcMain.on('api:abort', abortHandler)

        // Clean up abort listener and timers when request completes
        httpReq.on('close', () => {
          clearConnectionTimer()
          clearIdleTimer()
          ipcMain.removeListener('api:abort', abortHandler)
        })

        if (bodyBuffer) {
          httpReq.write(bodyBuffer)
        }
        httpReq.end()
        return
      }
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
      const reqHeaders = { ...headers }
      if (bodyBuffer) {
        reqHeaders['Content-Length'] = String(bodyBuffer.byteLength)
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: reqHeaders
      }

      // Timeouts (ms):
      // - Connection: max wait for the server to start responding (first byte)
      // - Idle: max gap between consecutive data chunks during streaming
      const CONNECTION_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_CONNECTION_TIMEOUT_MS', 180_000)
      const IDLE_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_IDLE_TIMEOUT_MS', 300_000)
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const clearIdleTimer = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      const resetIdleTimer = (req: http.ClientRequest): void => {
        if (IDLE_TIMEOUT <= 0) return
        clearIdleTimer()
        idleTimer = setTimeout(() => {
          console.warn(`[API Proxy] Idle timeout (${IDLE_TIMEOUT}ms) for ${requestId}`)
          req.destroy(new Error(`Stream idle timeout (${IDLE_TIMEOUT / 1000}s with no data)`))
        }, IDLE_TIMEOUT)
      }

      const httpReq = httpModule.request(options, (res) => {
        const statusCode = res.statusCode || 0
        sendQuotaUpdate(event, { requestId, url, providerId, providerBuiltinId }, res.headers ?? {})

        // For non-2xx, collect full body and send as error
        if (statusCode < 200 || statusCode >= 300) {
          clearIdleTimer()
          let errorBody = ''
          res.on('data', (chunk: Buffer) => {
            if (errorBody.length < 4000) errorBody += chunk.toString()
          })
          res.on('end', () => {
            console.error(
              `[API Proxy] stream-request[${requestId}] HTTP ${statusCode}: ${errorBody.slice(0, 500)}`
            )
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-error', {
                requestId,
                error: `HTTP ${statusCode}: ${errorBody.slice(0, 2000)}`
              })
            }
          })
          return
        }

        // Stream SSE chunks to renderer
        res.on('data', (chunk: Buffer) => {
          resetIdleTimer(httpReq)
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-chunk', {
              requestId,
              data: chunk.toString()
            })
          }
        })

        res.on('end', () => {
          clearIdleTimer()
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-end', { requestId })
          }
        })

        res.on('error', (err) => {
          clearIdleTimer()
          console.error(`[API Proxy] stream-request[${requestId}] response error: ${err.message}`)
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-error', {
              requestId,
              error: err.message
            })
          }
        })
      })

      // Connection timeout: abort if the server doesn't respond at all
      if (CONNECTION_TIMEOUT > 0) {
        httpReq.setTimeout(CONNECTION_TIMEOUT, () => {
          console.warn(`[API Proxy] Connection timeout (${CONNECTION_TIMEOUT}ms) for ${requestId}`)
          httpReq.destroy(new Error(`Connection timeout (${CONNECTION_TIMEOUT / 1000}s)`))
        })
      }

      httpReq.on('error', (err) => {
        clearIdleTimer()
        console.error(`[API Proxy] stream-request[${requestId}] request error: ${err.message}`)
        const sender = getSender(event)
        if (sender) {
          sender.send('api:stream-error', {
            requestId,
            error: err.message
          })
        }
      })

      // Handle abort from renderer
      const abortHandler = (_event: Electron.IpcMainEvent, data: { requestId: string }): void => {
        if (data.requestId === requestId) {
          clearIdleTimer()
          httpReq.destroy()
          ipcMain.removeListener('api:abort', abortHandler)
        }
      }
      ipcMain.on('api:abort', abortHandler)

      // Clean up abort listener and timers when request completes
      httpReq.on('close', () => {
        clearIdleTimer()
        ipcMain.removeListener('api:abort', abortHandler)
      })

      if (bodyBuffer) {
        httpReq.write(bodyBuffer)
      }
      httpReq.end()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[API Proxy] stream-request[${requestId}] fatal error: ${errMsg}`)
      const sender = getSender(event)
      if (sender) {
        sender.send('api:stream-error', {
          requestId,
          error: errMsg
        })
      }
    }
  })
}

function getSender(event: Electron.IpcMainEvent): Electron.WebContents | null {
  try {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      return event.sender
    }
  } catch {
    // Window may have been closed
  }
  return null
}
