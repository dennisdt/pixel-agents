import { ZOOM_DEFAULT_DPR_FACTOR, ZOOM_MIN, EXP_BASE, EXP_GROWTH_FACTOR } from '../constants.js'

/** Map status prefixes back to tool names for animation selection */
export const STATUS_TO_TOOL: Record<string, string> = {
  'Reading': 'Read',
  'Searching': 'Grep',
  'Globbing': 'Glob',
  'Fetching': 'WebFetch',
  'Searching web': 'WebSearch',
  'Writing': 'Write',
  'Editing': 'Edit',
  'Running': 'Bash',
  'Task': 'Task',
}

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool
  }
  const first = status.split(/[\s:]/)[0]
  return first || null
}

export function calculateLevel(totalExp: number): {
  level: number
  currentLevelExp: number
  nextLevelExp: number
  progress: number
} {
  let level = 1
  let expConsumed = 0
  let threshold = EXP_BASE
  while (expConsumed + threshold <= totalExp) {
    expConsumed += threshold
    level++
    threshold = Math.floor(EXP_BASE * Math.pow(EXP_GROWTH_FACTOR, level - 1))
  }
  const currentLevelExp = totalExp - expConsumed
  return { level, currentLevelExp, nextLevelExp: threshold, progress: threshold > 0 ? currentLevelExp / threshold : 0 }
}

/** Compute a default integer zoom level (device pixels per sprite pixel) */
export function defaultZoom(): number {
  const dpr = window.devicePixelRatio || 1
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr))
}
