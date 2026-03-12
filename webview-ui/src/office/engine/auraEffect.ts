import {
  AURA_SPARKLE_COUNT,
  AURA_SPARKLE_CYCLE_SEC,
  AURA_GLOW_ALPHA,
  AURA_GLOW_PIXEL_COUNT,
  AURA_FLAME_SPEED,
  AURA_FLAME_COUNT,
  AURA_RAINBOW_CYCLE_SEC,
  AURA_LIGHTNING_BURST_SEC,
  AURA_LIGHTNING_FLASH_SEC,
  AURA_COSMIC_ORBIT_SPEED,
  AURA_COSMIC_STAR_COUNT,
} from '../../constants.js'

/** Render an aura effect behind a character.
 *  @param ctx Canvas context
 *  @param auraId The aura type id
 *  @param x Character draw X (top-left of sprite in device pixels)
 *  @param y Character draw Y (top-left of sprite in device pixels)
 *  @param w Character sprite width in device pixels
 *  @param h Character sprite height in device pixels
 *  @param zoom Current zoom level
 *  @param auraTimer Monotonically increasing time (seconds)
 */
export function renderAura(
  ctx: CanvasRenderingContext2D,
  auraId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  auraTimer: number,
): void {
  switch (auraId) {
    case 'sparkle': renderSparkle(ctx, x, y, w, h, zoom, auraTimer); break
    case 'glow': renderGlow(ctx, x, y, w, h, zoom, auraTimer); break
    case 'flame': renderFlame(ctx, x, y, w, h, zoom, auraTimer); break
    case 'rainbow': renderRainbow(ctx, x, y, w, h, zoom, auraTimer); break
    case 'lightning': renderLightning(ctx, x, y, w, h, zoom, auraTimer); break
    case 'cosmic': renderCosmic(ctx, x, y, w, h, zoom, auraTimer); break
  }
}

/** Deterministic pseudo-random from seed */
function seeded(seed: number): number {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// ── Sparkle ─────────────────────────────────────────────────
function renderSparkle(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const radiusX = w / 2 + pxSize * 2
  const radiusY = h / 2 + pxSize * 2

  for (let i = 0; i < AURA_SPARKLE_COUNT; i++) {
    const seed = i * 73.37
    const angle = seeded(seed) * Math.PI * 2
    const dist = 0.6 + seeded(seed + 1) * 0.4
    const phase = seeded(seed + 2) * Math.PI * 2
    const brightness = Math.sin(t / AURA_SPARKLE_CYCLE_SEC * Math.PI * 2 + phase)

    if (brightness < 0) continue // hidden half the time

    const alpha = brightness * 0.8
    const px = cx + Math.cos(angle) * radiusX * dist
    const py = cy + Math.sin(angle) * radiusY * dist

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = brightness > 0.5 ? '#ffffff' : '#ffffaa'
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
    ctx.restore()
  }
}

// ── Glow ────────────────────────────────────────────────────
function renderGlow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const radiusX = w / 2 + pxSize
  const radiusY = h / 2 + pxSize

  ctx.save()
  ctx.globalAlpha = AURA_GLOW_ALPHA + Math.sin(t * 2) * 0.1
  ctx.fillStyle = '#88ddff'

  for (let i = 0; i < AURA_GLOW_PIXEL_COUNT; i++) {
    const angle = (i / AURA_GLOW_PIXEL_COUNT) * Math.PI * 2 + t * 0.3
    const px = cx + Math.cos(angle) * radiusX
    const py = cy + Math.sin(angle) * radiusY
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
  }

  ctx.restore()
}

// ── Flame ───────────────────────────────────────────────────
function renderFlame(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number,
): void {
  const pxSize = zoom
  const baseY = y + h // bottom of character
  const flameH = pxSize * 6

  for (let i = 0; i < AURA_FLAME_COUNT; i++) {
    const seed = i * 31.13
    const offsetX = x + seeded(seed) * w
    const rise = ((t * AURA_FLAME_SPEED + seeded(seed + 1) * flameH) % flameH)
    const py = baseY - rise
    const progress = rise / flameH // 0 at bottom, 1 at top

    // Color: orange → red → dark as it rises
    let color: string
    let alpha: number
    if (progress < 0.33) {
      color = '#ff8800'
      alpha = 0.9
    } else if (progress < 0.66) {
      color = '#ff4400'
      alpha = 0.6
    } else {
      color = '#881100'
      alpha = 0.3
    }

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fillRect(Math.round(offsetX), Math.round(py), pxSize, pxSize)
    ctx.restore()
  }
}

// ── Rainbow ─────────────────────────────────────────────────
function renderRainbow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const radiusX = w / 2 + pxSize * 2
  const radiusY = h / 2 + pxSize * 2

  for (let i = 0; i < AURA_SPARKLE_COUNT; i++) {
    const seed = i * 73.37
    const angle = seeded(seed) * Math.PI * 2
    const dist = 0.6 + seeded(seed + 1) * 0.4
    const phase = seeded(seed + 2) * Math.PI * 2
    const brightness = Math.sin(t / AURA_SPARKLE_CYCLE_SEC * Math.PI * 2 + phase)

    if (brightness < 0) continue

    const hue = ((t / AURA_RAINBOW_CYCLE_SEC * 360) + i * 72) % 360
    const px = cx + Math.cos(angle) * radiusX * dist
    const py = cy + Math.sin(angle) * radiusY * dist

    ctx.save()
    ctx.globalAlpha = brightness * 0.8
    ctx.fillStyle = `hsl(${hue}, 100%, 65%)`
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
    ctx.restore()
  }
}

// ── Lightning ───────────────────────────────────────────────
function renderLightning(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const radiusX = w / 2 + pxSize * 2
  const radiusY = h / 2 + pxSize * 2

  // Flash in bursts: on for FLASH_SEC, off for rest of BURST_SEC cycle
  const burstPhase = t % AURA_LIGHTNING_BURST_SEC
  if (burstPhase > AURA_LIGHTNING_FLASH_SEC * 3) return // pause between bursts

  // 1-3 quick flashes
  const flashIdx = Math.floor(burstPhase / AURA_LIGHTNING_FLASH_SEC)
  const flashSeed = Math.floor(t / AURA_LIGHTNING_BURST_SEC) * 100 + flashIdx

  ctx.save()
  ctx.globalAlpha = 0.9
  ctx.fillStyle = '#ffffff'

  // Draw 2-3 bright pixels in an arc
  for (let i = 0; i < 3; i++) {
    const s = flashSeed + i * 17.3
    const angle = seeded(s) * Math.PI * 2
    const dist = 0.5 + seeded(s + 1) * 0.5
    const px = cx + Math.cos(angle) * radiusX * dist
    const py = cy + Math.sin(angle) * radiusY * dist
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
  }

  // Connecting pixel between first two for "arc" feel
  const s0 = flashSeed + 0 * 17.3
  const s1 = flashSeed + 1 * 17.3
  const a0 = seeded(s0) * Math.PI * 2
  const a1 = seeded(s1) * Math.PI * 2
  const midAngle = (a0 + a1) / 2
  const midDist = 0.4 + seeded(flashSeed + 50) * 0.3
  ctx.globalAlpha = 0.6
  ctx.fillStyle = '#ccddff'
  ctx.fillRect(
    Math.round(cx + Math.cos(midAngle) * radiusX * midDist),
    Math.round(cy + Math.sin(midAngle) * radiusY * midDist),
    pxSize, pxSize,
  )

  ctx.restore()
}

// ── Cosmic ──────────────────────────────────────────────────
function renderCosmic(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2

  for (let i = 0; i < AURA_COSMIC_STAR_COUNT; i++) {
    const seed = i * 53.71
    const orbitRadius = (w / 2 + pxSize * 2) * (0.7 + seeded(seed) * 0.6)
    const speed = AURA_COSMIC_ORBIT_SPEED * (0.6 + seeded(seed + 1) * 0.8)
    const startAngle = seeded(seed + 2) * Math.PI * 2
    const angle = startAngle + t * speed

    // Elliptical orbit (wider horizontally)
    const px = cx + Math.cos(angle) * orbitRadius
    const py = cy + Math.sin(angle) * orbitRadius * 0.6

    // Color drift
    const hue = ((t * 30) + i * 72) % 360
    // Twinkle pulse
    const twinkle = 0.5 + Math.sin(t * 4 + i * 1.5) * 0.5

    ctx.save()
    ctx.globalAlpha = twinkle * 0.8
    ctx.fillStyle = `hsl(${hue}, 80%, 70%)`
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
    ctx.restore()
  }
}
