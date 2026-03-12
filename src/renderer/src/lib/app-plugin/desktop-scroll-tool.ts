import { IPC } from '@renderer/lib/ipc/channels'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_SCROLL_TOOL_NAME } from './types'

interface DesktopScrollResult {
  success?: boolean
  error?: string
  x?: number
  y?: number
  scrollX?: number
  scrollY?: number
}

export const desktopScrollTool: ToolHandler = {
  definition: {
    name: DESKTOP_SCROLL_TOOL_NAME,
    description:
      'Scroll on the desktop. Optionally move the pointer to x/y first, then apply scrollX/scrollY deltas.',
    inputSchema: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'Optional X coordinate to move the pointer to before scrolling.'
        },
        y: {
          type: 'number',
          description: 'Optional Y coordinate to move the pointer to before scrolling.'
        },
        scrollX: {
          type: 'number',
          description: 'Horizontal scroll delta. Defaults to 0.'
        },
        scrollY: {
          type: 'number',
          description: 'Vertical scroll delta. Positive/negative direction depends on the OS.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async (input, ctx) => {
    const x = input.x == null ? undefined : Number(input.x)
    const y = input.y == null ? undefined : Number(input.y)
    const scrollX = Number(input.scrollX ?? 0)
    const scrollY = Number(input.scrollY ?? 0)

    if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) {
      return JSON.stringify({ error: 'DesktopScroll requires numeric scrollX and scrollY values.' })
    }

    if ((x == null) !== (y == null)) {
      return JSON.stringify({
        error: 'DesktopScroll requires both x and y when specifying a scroll anchor.'
      })
    }

    if (x != null && y != null && (!Number.isFinite(x) || !Number.isFinite(y))) {
      return JSON.stringify({ error: 'DesktopScroll requires numeric x and y coordinates.' })
    }

    const result = (await ctx.ipc.invoke(IPC.DESKTOP_INPUT_SCROLL, {
      x,
      y,
      scrollX,
      scrollY
    })) as DesktopScrollResult

    if (!result?.success) {
      return JSON.stringify({ error: result?.error || 'Desktop scroll failed.' })
    }

    return JSON.stringify({
      success: true,
      x: result.x ?? x,
      y: result.y ?? y,
      scrollX: result.scrollX ?? scrollX,
      scrollY: result.scrollY ?? scrollY,
      message:
        result.x != null && result.y != null
          ? `Desktop scroll executed at (${result.x}, ${result.y}) with delta (${result.scrollX ?? scrollX}, ${result.scrollY ?? scrollY}).`
          : `Desktop scroll executed with delta (${result.scrollX ?? scrollX}, ${result.scrollY ?? scrollY}).`
    })
  },
  requiresApproval: () => true
}
