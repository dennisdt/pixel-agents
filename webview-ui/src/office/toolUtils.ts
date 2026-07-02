import {
  EXP_BASE_COST,
  EXP_TIERS,
  LEVEL_AURAS,
  LEVEL_TITLES,
  ZOOM_DEFAULT_DPR_FACTOR,
  ZOOM_MIN,
} from '../constants.js';

/** Map status prefixes back to tool names for animation selection */
const STATUS_TO_TOOL: Record<string, string> = {
  Reading: 'Read',
  Searching: 'Grep',
  Globbing: 'Glob',
  Fetching: 'WebFetch',
  'Searching web': 'WebSearch',
  Writing: 'Write',
  Editing: 'Edit',
  Running: 'Bash',
  Task: 'Task',
};

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool;
  }
  const first = status.split(/[\s:]/)[0];
  return first || null;
}

/** Compute a default integer zoom level (device pixels per sprite pixel).
 *  Reads DPR off globalThis so this module stays importable outside the DOM
 *  (e.g. under the node test runner). */
export function defaultZoom(): number {
  const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr));
}

/** Return the EXP growth multiplier for the tier that contains `level`. */
function getGrowthForLevel(level: number): number {
  for (const tier of EXP_TIERS) {
    if (level <= tier.maxLevel) return tier.growth;
  }
  return EXP_TIERS[EXP_TIERS.length - 1].growth;
}

/** Convert cumulative EXP into level, progress within current level, and threshold for next. */
export function calculateLevel(totalExp: number): {
  level: number;
  currentLevelExp: number;
  nextLevelExp: number;
  progress: number;
} {
  let level = 1;
  let expConsumed = 0;
  let threshold = EXP_BASE_COST;
  while (expConsumed + threshold <= totalExp) {
    expConsumed += threshold;
    level++;
    threshold = Math.floor(threshold * getGrowthForLevel(level));
  }
  const currentLevelExp = totalExp - expConsumed;
  const progress = threshold > 0 ? currentLevelExp / threshold : 0;
  return { level, currentLevelExp, nextLevelExp: threshold, progress };
}

/** Index of the last entry in a level-ascending table where `level >= entry.level`.
 *  Returns -1 if none qualify. Hand-rolled because lib target is ES2022; could
 *  be `table.findLastIndex(...)` if the tsconfig lib bumps to ES2023. */
function findRewardIndex<T extends { level: number }>(table: readonly T[], level: number): number {
  let idx = -1;
  for (let i = 0; i < table.length; i++) {
    if (level >= table[i].level) idx = i;
    else break;
  }
  return idx;
}

/** Get the title and color for a given level */
export function getTitleForLevel(level: number): { title: string; color: string } {
  const idx = findRewardIndex(LEVEL_TITLES, level);
  const entry = idx >= 0 ? LEVEL_TITLES[idx] : LEVEL_TITLES[0];
  return { title: entry.title, color: entry.color };
}

/** Get the highest unlocked aura id for a given level, or null */
export function getAuraForLevel(level: number): string | null {
  const idx = findRewardIndex(LEVEL_AURAS, level);
  return idx >= 0 ? LEVEL_AURAS[idx].id : null;
}

/** Aura intensity (0.0-1.0) scales progress through current aura tier.
 *  0.0 = just unlocked, 1.0 = at or past the next tier threshold. The FINAL
 *  tier unlocks at full intensity — reaching the top of the ladder shouldn't
 *  render the flagship aura at its weakest. */
export function getAuraIntensity(level: number): number {
  const idx = findRewardIndex(LEVEL_AURAS, level);
  if (idx < 0) return 0;
  if (idx === LEVEL_AURAS.length - 1) return 1;
  const start = LEVEL_AURAS[idx].level;
  const end = LEVEL_AURAS[idx + 1].level;
  return Math.min(1, (level - start) / (end - start));
}

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated per provider by `providerCapabilities` messages after `webviewReady`.
// Classification uses the union across providers: tool-name collisions across
// providers are semantically compatible (a "read" tool reads), so a per-agent
// lookup isn't needed. Seeded with Claude defaults so classification works
// before — or entirely without — a message (e.g. older servers).
const providerCapsById = new Map<
  string,
  { readingTools: Set<string>; subagentToolNames: Set<string> }
>([
  [
    'claude',
    {
      readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
      subagentToolNames: new Set(['Task', 'Agent']),
    },
  ],
]);

export function setProviderCapabilities(caps: {
  providerId?: string;
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCapsById.set(caps.providerId ?? 'claude', {
    readingTools: new Set(caps.readingTools),
    subagentToolNames: new Set(caps.subagentToolNames),
  });
}

export function isReadingToolName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  for (const caps of providerCapsById.values()) if (caps.readingTools.has(name)) return true;
  return false;
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  for (const caps of providerCapsById.values()) if (caps.subagentToolNames.has(name)) return true;
  return false;
}
