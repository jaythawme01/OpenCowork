import type { ImageBlock, TextBlock, ToolResultContent } from '@renderer/lib/api/types'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { IPC } from '@renderer/lib/ipc/channels'
import { DESKTOP_SCREENSHOT_TOOL_NAME } from './types'

interface DesktopScreenshotResult {
  success?: boolean
  error?: string
  width?: number
  height?: number
  displayCount?: number
  mediaType?: string
  data?: string
}

export const desktopScreenshotTool: ToolHandler = {
  definition: {
    name: DESKTOP_SCREENSHOT_TOOL_NAME,
    description:
      'Capture a full desktop screenshot and return it to the agent. Use this before mouse or keyboard actions when the current screen state matters.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: {
          type: 'number',
          description: 'Optional delay in milliseconds before capturing the screenshot.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async (input, ctx): Promise<ToolResultContent> => {
    const delayMs = Number(input.delayMs ?? 0)
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5000)))
    }

    const result = (await ctx.ipc.invoke(IPC.DESKTOP_SCREENSHOT_CAPTURE)) as DesktopScreenshotResult

    if (!result?.success || !result.data) {
      return JSON.stringify({ error: result?.error || 'Failed to capture desktop screenshot.' })
    }

    const notes: TextBlock[] = [
      {
        type: 'text',
        text: `Captured desktop screenshot ${result.width ?? '?'}x${result.height ?? '?'} across ${result.displayCount ?? 1} display(s).`
      }
    ]

    const image: ImageBlock = {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: result.mediaType || 'image/png',
        data: result.data
      }
    }

    return [image, ...notes]
  },
  requiresApproval: () => true
}
