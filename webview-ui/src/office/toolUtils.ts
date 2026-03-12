import { ZOOM_DEFAULT_DPR_FACTOR, ZOOM_MIN, EXP_BASE_COST, EXP_TIERS } from '../constants.js'

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

/** Return the EXP growth multiplier for the tier that contains `level`. */
function getGrowthForLevel(level: number): number {
  for (const tier of EXP_TIERS) {
    if (level <= tier.maxLevel) return tier.growth
  }
  return EXP_TIERS[EXP_TIERS.length - 1].growth
}

export function calculateLevel(totalExp: number): {
  level: number
  currentLevelExp: number
  nextLevelExp: number
  progress: number
} {
  let level = 1
  let expConsumed = 0
  let threshold = EXP_BASE_COST
  while (expConsumed + threshold <= totalExp) {
    expConsumed += threshold
    level++
    threshold = Math.floor(threshold * getGrowthForLevel(level))
  }
  const currentLevelExp = totalExp - expConsumed
  const progress = threshold > 0 ? currentLevelExp / threshold : 0
  return { level, currentLevelExp, nextLevelExp: threshold, progress }
}

/** Compute a default integer zoom level (device pixels per sprite pixel) */
export function defaultZoom(): number {
  const dpr = window.devicePixelRatio || 1
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr))
}
