import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_WAIT_TOOL_NAME } from './types'

export const desktopWaitTool: ToolHandler = {
  definition: {
    name: DESKTOP_WAIT_TOOL_NAME,
    description: 'Pause desktop automation for a short period before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: {
          type: 'number',
          description: 'Delay in milliseconds before continuing. Defaults to 2000.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async (input) => {
    const delayMs = Number(input.delayMs ?? 2000)
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return JSON.stringify({ error: 'DesktopWait requires a non-negative numeric delayMs.' })
    }

    const boundedDelayMs = Math.min(delayMs, 10000)
    await new Promise((resolve) => setTimeout(resolve, boundedDelayMs))

    return JSON.stringify({
      success: true,
      delayMs: boundedDelayMs,
      message: `Desktop wait completed after ${boundedDelayMs}ms.`
    })
  },
  requiresApproval: () => true
}
