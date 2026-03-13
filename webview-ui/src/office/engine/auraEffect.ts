import {
  AURA_SPARKLE_CYCLE_SEC,
  AURA_RAINBOW_CYCLE_SEC,
  AURA_LIGHTNING_BURST_SEC,
  AURA_LIGHTNING_FLASH_SEC,
  AURA_COSMIC_ORBIT_SPEED,
} from '../../constants.js'

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t
}

/** Render an aura effect behind a character.
 *  @param intensity 0.0 (just unlocked) to 1.0 (max tier progression)
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
  intensity: number,
): void {
  switch (auraId) {
    case 'sparkle': renderSparkle(ctx, x, y, w, h, zoom, auraTimer, intensity); break
    case 'glow': renderGlow(ctx, x, y, w, h, zoom, auraTimer, intensity); break
    case 'flame': renderFlame(ctx, x, y, w, h, zoom, auraTimer, intensity); break
    case 'rainbow': renderRainbow(ctx, x, y, w, h, zoom, auraTimer, intensity); break
    case 'lightning': renderLightning(ctx, x, y, w, h, zoom, auraTimer, intensity); break
    case 'cosmic': renderCosmic(ctx, x, y, w, h, zoom, auraTimer, intensity); break
  }
}

/** Deterministic pseudo-random from seed */
function seeded(seed: number): number {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// ── Sparkle ─────────────────────────────────────────────────
// Scales: 3→8 particles, alpha 0.4→0.9, radius +1→+3px
function renderSparkle(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number, intensity: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const spread = lerp(1, 3, intensity)
  const radiusX = w / 2 + pxSize * spread
  const radiusY = h / 2 + pxSize * spread
  const count = Math.round(lerp(3, 8, intensity))
  const alphaScale = lerp(0.4, 0.9, intensity)

  ctx.save()
  for (let i = 0; i < count; i++) {
    const seed = i * 73.37
    const angle = seeded(seed) * Math.PI * 2
    const dist = 0.6 + seeded(seed + 1) * 0.4
    const phase = seeded(seed + 2) * Math.PI * 2
    const brightness = Math.sin(t / AURA_SPARKLE_CYCLE_SEC * Math.PI * 2 + phase)

    if (brightness < 0) continue

    const px = cx + Math.cos(angle) * radiusX * dist
    const py = cy + Math.sin(angle) * radiusY * dist

    ctx.globalAlpha = brightness * alphaScale
    ctx.fillStyle = brightness > 0.5 ? '#ffffff' : '#ffffaa'
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
  }
  ctx.restore()
}

// ── Glow ────────────────────────────────────────────────────
// Scales: 4→10 pixels, alpha 0.15→0.45, radius +0.5→+2px
function renderGlow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number, intensity: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const spread = lerp(0.5, 2, intensity)
  const radiusX = w / 2 + pxSize * spread
  const radiusY = h / 2 + pxSize * spread
  const count = Math.round(lerp(4, 10, intensity))
  const baseAlpha = lerp(0.15, 0.45, intensity)

  ctx.save()
  ctx.globalAlpha = baseAlpha + Math.sin(t * 2) * 0.1
  ctx.fillStyle = '#88ddff'

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + t * 0.3
    const px = cx + Math.cos(angle) * radiusX
    const py = cy + Math.sin(angle) * radiusY
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
  }

  ctx.restore()
}

// ── Flame ───────────────────────────────────────────────────
// Scales: 2→6 particles, height 4→8px, alpha 0.5→1.0 multiplier
function renderFlame(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number, intensity: number,
): void {
  const pxSize = zoom
  const baseY = y + h
  const flameH = pxSize * lerp(4, 8, intensity)
  const count = Math.round(lerp(2, 6, intensity))
  const alphaScale = lerp(0.5, 1.0, intensity)
  const speed = lerp(18, 30, intensity)

  ctx.save()
  for (let i = 0; i < count; i++) {
    const seed = i * 31.13
    const offsetX = x + seeded(seed) * w
    const rise = ((t * speed + seeded(seed + 1) * flameH) % flameH)
    const py = baseY - rise
    const progress = rise / flameH

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

    ctx.globalAlpha = alpha * alphaScale
    ctx.fillStyle = color
    ctx.fillRect(Math.round(offsetX), Math.round(py), pxSize, pxSize)
  }
  ctx.restore()
}

// ── Rainbow ─────────────────────────────────────────────────
// Scales: 3→8 particles, alpha 0.4→0.9, radius +1→+3px
function renderRainbow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number, intensity: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const spread = lerp(1, 3, intensity)
  const radiusX = w / 2 + pxSize * spread
  const radiusY = h / 2 + pxSize * spread
  const count = Math.round(lerp(3, 8, intensity))
  const alphaScale = lerp(0.4, 0.9, intensity)

  ctx.save()
  for (let i = 0; i < count; i++) {
    const seed = i * 73.37
    const angle = seeded(seed) * Math.PI * 2
    const dist = 0.6 + seeded(seed + 1) * 0.4
    const phase = seeded(seed + 2) * Math.PI * 2
    const brightness = Math.sin(t / AURA_SPARKLE_CYCLE_SEC * Math.PI * 2 + phase)

    if (brightness < 0) continue

    const hue = ((t / AURA_RAINBOW_CYCLE_SEC * 360) + i * 72) % 360
    const px = cx + Math.cos(angle) * radiusX * dist
    const py = cy + Math.sin(angle) * radiusY * dist

    ctx.globalAlpha = brightness * alphaScale
    ctx.fillStyle = `hsl(${hue}, 100%, 65%)`
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
  }
  ctx.restore()
}

// ── Lightning ───────────────────────────────────────────────
// Scales: 2→5 flash pixels, burst gap 1.8→1.0s, alpha 0.6→1.0
function renderLightning(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number, intensity: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const spread = lerp(1.5, 3, intensity)
  const radiusX = w / 2 + pxSize * spread
  const radiusY = h / 2 + pxSize * spread
  const burstInterval = lerp(AURA_LIGHTNING_BURST_SEC, 0.8, intensity)
  const flashCount = Math.round(lerp(2, 5, intensity))
  const alphaScale = lerp(0.6, 1.0, intensity)

  const burstPhase = t % burstInterval
  if (burstPhase > AURA_LIGHTNING_FLASH_SEC * 3) return

  const flashIdx = Math.floor(burstPhase / AURA_LIGHTNING_FLASH_SEC)
  const flashSeed = Math.floor(t / burstInterval) * 100 + flashIdx

  ctx.save()
  ctx.globalAlpha = alphaScale
  ctx.fillStyle = '#ffffff'

  for (let i = 0; i < flashCount; i++) {
    const s = flashSeed + i * 17.3
    const angle = seeded(s) * Math.PI * 2
    const dist = 0.5 + seeded(s + 1) * 0.5
    const px = cx + Math.cos(angle) * radiusX * dist
    const py = cy + Math.sin(angle) * radiusY * dist
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
  }

  // Connecting pixels for arc feel
  if (flashCount >= 2) {
    const s0 = flashSeed + 0 * 17.3
    const s1 = flashSeed + 1 * 17.3
    const a0 = seeded(s0) * Math.PI * 2
    const a1 = seeded(s1) * Math.PI * 2
    const midAngle = (a0 + a1) / 2
    const midDist = 0.4 + seeded(flashSeed + 50) * 0.3
    ctx.globalAlpha = alphaScale * 0.7
    ctx.fillStyle = '#ccddff'
    ctx.fillRect(
      Math.round(cx + Math.cos(midAngle) * radiusX * midDist),
      Math.round(cy + Math.sin(midAngle) * radiusY * midDist),
      pxSize, pxSize,
    )
  }

  ctx.restore()
}

// ── Cosmic ──────────────────────────────────────────────────
// Scales: 3→8 stars, orbit radius wider, twinkle brighter
function renderCosmic(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  zoom: number, t: number, intensity: number,
): void {
  const pxSize = zoom
  const cx = x + w / 2
  const cy = y + h / 2
  const count = Math.round(lerp(3, 8, intensity))
  const orbitScale = lerp(0.7, 1.3, intensity)
  const alphaScale = lerp(0.5, 0.9, intensity)

  ctx.save()
  for (let i = 0; i < count; i++) {
    const seed = i * 53.71
    const orbitRadius = (w / 2 + pxSize * 2) * (0.7 + seeded(seed) * 0.6) * orbitScale
    const speed = AURA_COSMIC_ORBIT_SPEED * (0.6 + seeded(seed + 1) * 0.8)
    const startAngle = seeded(seed + 2) * Math.PI * 2
    const angle = startAngle + t * speed

    const px = cx + Math.cos(angle) * orbitRadius
    const py = cy + Math.sin(angle) * orbitRadius * 0.6

    const hue = ((t * 30) + i * 72) % 360
    const twinkle = 0.5 + Math.sin(t * 4 + i * 1.5) * 0.5

    ctx.globalAlpha = twinkle * alphaScale
    ctx.fillStyle = `hsl(${hue}, 80%, 70%)`
    ctx.fillRect(Math.round(px), Math.round(py), pxSize, pxSize)
  }
  ctx.restore()
}
