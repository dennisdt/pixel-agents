import type { SpriteData, Direction } from '../types.js'
import { Direction as Dir } from '../types.js'

interface AccessoryDef {
  sprite: SpriteData
  /** Per-direction offset from character top-left (16x24 sprite, anchored bottom-center) */
  offsets: Record<Direction, { dx: number; dy: number }>
}

// Helper: transparent pixel
const _ = ''

// ── Glasses (Lv.5) ─────────────────────────────────────────
// 6x2 pixels, positioned on face (~row 7-8 from top of 24px sprite)
const GLASSES: AccessoryDef = {
  sprite: [
    ['#4488cc', '#4488cc', _, '#4488cc', '#4488cc', _],
    ['#4488cc', '#88ccff', _, '#4488cc', '#88ccff', _],
  ],
  offsets: {
    [Dir.DOWN]:  { dx: 5, dy: 8 },
    [Dir.UP]:    { dx: 5, dy: 7 },
    [Dir.RIGHT]: { dx: 8, dy: 8 },
    [Dir.LEFT]:  { dx: 2, dy: 8 },
  },
}

// ── Headband (Lv.10) ────────────────────────────────────────
// 8x2 pixels, across top of head (~row 3)
const HEADBAND: AccessoryDef = {
  sprite: [
    ['#cc3333', '#cc3333', '#cc3333', '#cc3333', '#cc3333', '#cc3333', '#cc3333', '#cc3333'],
    ['#aa2222', '#aa2222', '#aa2222', '#aa2222', '#aa2222', '#aa2222', '#aa2222', '#aa2222'],
  ],
  offsets: {
    [Dir.DOWN]:  { dx: 4, dy: 4 },
    [Dir.UP]:    { dx: 4, dy: 3 },
    [Dir.RIGHT]: { dx: 5, dy: 4 },
    [Dir.LEFT]:  { dx: 3, dy: 4 },
  },
}

// ── Hard Hat (Lv.15) ────────────────────────────────────────
// 10x3 pixels, on top of head
const HARDHAT: AccessoryDef = {
  sprite: [
    [_, _, '#ffcc00', '#ffcc00', '#ffcc00', '#ffcc00', '#ffcc00', '#ffcc00', _, _],
    [_, '#ffcc00', '#ffdd33', '#ffdd33', '#ffdd33', '#ffdd33', '#ffdd33', '#ffdd33', '#ffcc00', _],
    ['#ddaa00', '#ddaa00', '#ddaa00', '#ddaa00', '#ddaa00', '#ddaa00', '#ddaa00', '#ddaa00', '#ddaa00', '#ddaa00'],
  ],
  offsets: {
    [Dir.DOWN]:  { dx: 3, dy: 0 },
    [Dir.UP]:    { dx: 3, dy: -1 },
    [Dir.RIGHT]: { dx: 4, dy: 0 },
    [Dir.LEFT]:  { dx: 2, dy: 0 },
  },
}

// ── Crown (Lv.25) ──────────────────────────────────────────
// 8x4 pixels, gold with 3 points
const CROWN: AccessoryDef = {
  sprite: [
    [_, '#ffd700', _, _, _, _, '#ffd700', _],
    [_, '#ffd700', _, '#ffd700', '#ffd700', _, '#ffd700', _],
    ['#ffd700', '#ffed4a', '#ffd700', '#ffed4a', '#ffed4a', '#ffd700', '#ffed4a', '#ffd700'],
    ['#daa520', '#daa520', '#daa520', '#daa520', '#daa520', '#daa520', '#daa520', '#daa520'],
  ],
  offsets: {
    [Dir.DOWN]:  { dx: 4, dy: -2 },
    [Dir.UP]:    { dx: 4, dy: -3 },
    [Dir.RIGHT]: { dx: 5, dy: -2 },
    [Dir.LEFT]:  { dx: 3, dy: -2 },
  },
}

// ── Halo (Lv.35) ───────────────────────────────────────────
// 10x3 pixels, golden ring above head (semi-transparent via lighter colors)
const HALO: AccessoryDef = {
  sprite: [
    [_, _, '#ffeebb', '#ffeebb', '#ffeebb', '#ffeebb', '#ffeebb', '#ffeebb', _, _],
    [_, '#ffd700', _, _, _, _, _, _, '#ffd700', _],
    [_, _, '#ffeebb', '#ffeebb', '#ffeebb', '#ffeebb', '#ffeebb', '#ffeebb', _, _],
  ],
  offsets: {
    [Dir.DOWN]:  { dx: 3, dy: -4 },
    [Dir.UP]:    { dx: 3, dy: -5 },
    [Dir.RIGHT]: { dx: 4, dy: -4 },
    [Dir.LEFT]:  { dx: 2, dy: -4 },
  },
}

// ── Horns (Lv.40) ──────────────────────────────────────────
// 10x4 pixels, fiery red/orange devil horns
const HORNS: AccessoryDef = {
  sprite: [
    ['#ff2200', _, _, _, _, _, _, _, _, '#ff2200'],
    ['#ff4400', '#ff2200', _, _, _, _, _, _, '#ff2200', '#ff4400'],
    [_, '#ff6600', '#ff4400', _, _, _, _, '#ff4400', '#ff6600', _],
    [_, _, '#ff6600', _, _, _, _, '#ff6600', _, _],
  ],
  offsets: {
    [Dir.DOWN]:  { dx: 3, dy: -2 },
    [Dir.UP]:    { dx: 3, dy: -3 },
    [Dir.RIGHT]: { dx: 4, dy: -2 },
    [Dir.LEFT]:  { dx: 2, dy: -2 },
  },
}

// ── Wings (Lv.50) ──────────────────────────────────────────
// 18x6 pixels, small translucent pixel wings on each side
const WINGS: AccessoryDef = {
  sprite: [
    [_, _, _, '#aaddff', _, _, _, _, _, _, _, _, _, _, '#aaddff', _, _, _],
    [_, _, '#aaddff', '#88bbee', '#aaddff', _, _, _, _, _, _, _, _, '#aaddff', '#88bbee', '#aaddff', _, _],
    [_, '#aaddff', '#88bbee', '#6699cc', '#88bbee', '#aaddff', _, _, _, _, _, _, '#aaddff', '#88bbee', '#6699cc', '#88bbee', '#aaddff', _],
    ['#aaddff', '#88bbee', '#6699cc', '#6699cc', '#88bbee', _, _, _, _, _, _, _, _, '#88bbee', '#6699cc', '#6699cc', '#88bbee', '#aaddff'],
    [_, '#aaddff', '#88bbee', '#88bbee', _, _, _, _, _, _, _, _, _, _, '#88bbee', '#88bbee', '#aaddff', _],
    [_, _, '#aaddff', _, _, _, _, _, _, _, _, _, _, _, _, '#aaddff', _, _],
  ],
  offsets: {
    [Dir.DOWN]:  { dx: -1, dy: 6 },
    [Dir.UP]:    { dx: -1, dy: 5 },
    [Dir.RIGHT]: { dx: 0, dy: 6 },
    [Dir.LEFT]:  { dx: -2, dy: 6 },
  },
}

const ACCESSORY_MAP: Record<string, AccessoryDef> = {
  glasses: GLASSES,
  headband: HEADBAND,
  hardhat: HARDHAT,
  crown: CROWN,
  halo: HALO,
  horns: HORNS,
  wings: WINGS,
}

/** Flip a sprite horizontally (mirror each row) */
function flipSprite(sprite: SpriteData): SpriteData {
  return sprite.map((row) => [...row].reverse())
}

export function getAccessoryData(
  id: string,
  direction: Direction,
): { sprite: SpriteData; dx: number; dy: number } | null {
  const def = ACCESSORY_MAP[id]
  if (!def) return null
  const offset = def.offsets[direction]
  // LEFT = horizontally flipped RIGHT sprite
  const sprite = direction === Dir.LEFT ? flipSprite(def.sprite) : def.sprite
  return { sprite, dx: offset.dx, dy: offset.dy }
}
