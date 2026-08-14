import {
  AURA_ASCENDANT_PULSE_SEC,
  AURA_ASCENDANT_RAY_ROTATE_SEC,
  AURA_ASCENDANT_SIGIL_ROTATE_SEC,
  AURA_EMBER_RISE_SEC,
  AURA_GALAXY_COMET_SEC,
  AURA_GALAXY_ROTATE_SEC,
  AURA_HALO_BOB_SEC,
  AURA_HALO_GLINT_SEC,
  AURA_PHOENIX_EMBER_RISE_SEC,
  AURA_PHOENIX_FLICKER_HZ,
  AURA_PHOENIX_WING_SEC,
  AURA_PRISM_HUE_DRIFT_SEC,
  AURA_SPARKLE_CYCLE_SEC,
  AURA_STATIC_BURST_FAST_SEC,
  AURA_STATIC_BURST_SLOW_SEC,
  AURA_STATIC_FLASH_SEC,
  AURA_STORM_ARC_FAST_SEC,
  AURA_STORM_ARC_FLASH_SEC,
  AURA_STORM_ARC_SLOW_SEC,
  AURA_STORM_RING_ROTATE_SEC,
} from '../../constants.js';

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/** Render an aura effect behind a character.
 *
 *  Design language: discrete pixel shapes, never soft gradient blobs. The
 *  ladder ESCALATES — early tiers are quiet glints; from storm (65) upward the
 *  effects become genuine spectacle (ground rings, flame mantles, sigils,
 *  light pillars) so high-level agents visibly radiate status. Spectacle comes
 *  from composition and choreography, not from strobing or filling the screen.
 *
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
    case 'sparkle':
      renderSparkle(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'halo':
      renderHalo(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'ember':
      renderEmber(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'prism':
      renderPrism(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'static':
      renderStatic(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'galaxy':
      renderGalaxy(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'storm':
      renderStorm(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'phoenix':
      renderPhoenix(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
    case 'ascendant':
      renderAscendant(ctx, x, y, w, h, zoom, auraTimer, intensity);
      break;
  }
}

/** Deterministic pseudo-random from seed */
function seeded(seed: number): number {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ── Shared glyphs / primitives ──────────────────────────────

/** The classic brightness-staged pixel star: center pixel (always) → 5-pixel
 *  cross from mid-brightness → 9-pixel star at peak, with the far arms drawn
 *  brighter. One glyph shared by every "star" in the ladder (sparkle, prism,
 *  galaxy guardians) so the shape language stays consistent. */
function drawPixelStar(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  pxSize: number,
  b: number,
  alphaScale: number,
  bright: string,
  dim: string,
): void {
  ctx.globalAlpha = Math.min(1, b * alphaScale);
  ctx.fillStyle = b > 0.6 ? bright : dim;
  ctx.fillRect(px, py, pxSize, pxSize);
  if (b > 0.3) {
    ctx.fillRect(px - pxSize, py, pxSize, pxSize);
    ctx.fillRect(px + pxSize, py, pxSize, pxSize);
    ctx.fillRect(px, py - pxSize, pxSize, pxSize);
    ctx.fillRect(px, py + pxSize, pxSize, pxSize);
  }
  if (b > 0.75) {
    ctx.globalAlpha = Math.min(1, (b - 0.5) * alphaScale * 1.5);
    ctx.fillStyle = bright;
    ctx.fillRect(px - pxSize * 2, py, pxSize, pxSize);
    ctx.fillRect(px + pxSize * 2, py, pxSize, pxSize);
    ctx.fillRect(px, py - pxSize * 2, pxSize, pxSize);
    ctx.fillRect(px, py + pxSize * 2, pxSize, pxSize);
  }
}

/** A burst of short electric ticks: jittered 3-5 pixel random-walk dashes at
 *  random points on an ellipse around (cx, cy). Shared by the two electric
 *  tiers (static, storm) so they read as one visual language at two scales. */
function drawElectricTicks(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  pxSize: number,
  count: number,
  fade: number,
  seedBase: number,
): void {
  for (let i = 0; i < count; i++) {
    const seed = seedBase + i * 11.3;
    const angle = seeded(seed) * Math.PI * 2;
    let px = Math.round(cx + Math.cos(angle) * rx);
    let py = Math.round(cy + Math.sin(angle) * ry);
    const steps = 3 + Math.round(seeded(seed + 1));
    for (let s = 0; s < steps; s++) {
      ctx.globalAlpha = fade * (s === 0 ? 1 : 0.7);
      ctx.fillStyle = s === 0 ? '#ffffff' : '#9fe8ff';
      ctx.fillRect(px, py, pxSize, pxSize);
      px += (seeded(seed + 2 + s) > 0.5 ? 1 : -1) * pxSize;
      py += seeded(seed + 7 + s) > 0.5 ? -pxSize : pxSize;
    }
  }
}

/** A field of warm motes drifting up from a baseline, swaying and fading as
 *  they rise — shared by ember (Lv.25) and phoenix's ember shower (Lv.80). */
function drawEmberMotes(
  ctx: CanvasRenderingContext2D,
  t: number,
  spanX: number,
  spanW: number,
  baseY: number,
  riseH: number,
  count: number,
  riseSec: number,
  pxSize: number,
  alphaScale: number,
): void {
  for (let i = 0; i < count; i++) {
    const seed = i * 47.3;
    const speed = 0.8 + seeded(seed) * 0.5;
    const progress = ((t / riseSec) * speed + seeded(seed + 1)) % 1;
    const sway = Math.sin(progress * Math.PI * 2 + seed) * pxSize * 1.2;
    const px = Math.round(spanX + seeded(seed + 2) * spanW + sway);
    const py = Math.round(baseY - progress * riseH);

    const color = progress < 0.25 ? '#ffe08a' : progress < 0.6 ? '#ff9a3c' : '#c84f1d';
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    // Stay visible most of the rise, then fade out over the last stretch.
    ctx.globalAlpha = Math.min(1, (1 - progress) * 2.5) * alphaScale;
    const size = progress < 0.2 ? pxSize * 2 : pxSize;
    ctx.fillRect(px, py, size, size);
  }
}

// ── Shared twinkle core (sparkle + prism) ───────────────────
// Classic pixel-art twinkles: fixed cross/star shapes arranged in a loose
// ring around the character that pulse in place over a slow cycle. Each
// twinkle has its own phase so they don't all pulse together. Shape grows
// from a single pixel through a 5-pixel cross to a 9-pixel star as
// brightness peaks, then fades back down. No translational motion — the
// character isn't shooting particles, it's surrounded by magical glints.
interface TwinkleColors {
  dim: string;
  bright: string;
  shadow: string;
}

function renderTwinkles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
  countMin: number,
  countMax: number,
  colorsAt: (i: number) => TwinkleColors,
): void {
  const pxSize = zoom;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const count = Math.round(lerp(countMin, countMax, intensity));
  const alphaScale = lerp(0.8, 1.0, intensity);
  const baseRadiusX = w / 2 + pxSize * 2;
  const baseRadiusY = (h / 2 + pxSize * 2) * 0.85; // flatter for perspective

  ctx.save();
  ctx.shadowBlur = pxSize * 2;

  for (let i = 0; i < count; i++) {
    const seed = i * 73.37;
    // Fixed angle + radius per seed so the twinkle stays in one place.
    const angleBase = (i / count) * Math.PI * 2;
    const angle = angleBase + (seeded(seed) - 0.5) * 0.8;
    const radiusJitter = 0.85 + seeded(seed + 1) * 0.35;
    const px = Math.round(cx + Math.cos(angle) * baseRadiusX * radiusJitter);
    const py = Math.round(cy + Math.sin(angle) * baseRadiusY * radiusJitter);

    const phase = seeded(seed + 2) * Math.PI * 2;
    const brightness = Math.sin((t / AURA_SPARKLE_CYCLE_SEC) * Math.PI * 2 + phase);
    if (brightness < -0.2) continue;

    const colors = colorsAt(i);
    ctx.shadowColor = colors.shadow;
    drawPixelStar(
      ctx,
      px,
      py,
      pxSize,
      Math.max(0, brightness),
      alphaScale,
      colors.bright,
      colors.dim,
    );
  }
  ctx.restore();
}

// ── Sparkle (Lv.12) ─────────────────────────────────────────
// The original warm-white twinkles, unchanged.
const SPARKLE_COLORS: TwinkleColors = { dim: '#ffffaa', bright: '#ffffff', shadow: '#fff8b0' };

function renderSparkle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  renderTwinkles(ctx, x, y, w, h, zoom, t, intensity, 6, 10, () => SPARKLE_COLORS);
}

// ── Halo (Lv.15) ────────────────────────────────────────────
// A thin gold ring of still pixels floating above the head, bobbing gently,
// with a single white glint traveling around it. The back of the ring is
// dimmer so it reads as a tilted disc.
function renderHalo(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  _h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  const pxSize = zoom;
  const cx = x + w / 2;
  const bob = Math.sin((t / AURA_HALO_BOB_SEC) * Math.PI * 2) * pxSize * 0.6;
  const cy = y - pxSize * 2.5 + bob;
  const radiusX = w * lerp(0.32, 0.4, intensity);
  const radiusY = radiusX * 0.32; // tilted disc perspective
  const dots = 14;

  ctx.save();
  ctx.shadowBlur = pxSize * 2;
  ctx.shadowColor = '#ffd700';
  for (let i = 0; i < dots; i++) {
    const angle = (i / dots) * Math.PI * 2;
    const px = Math.round(cx + Math.cos(angle) * radiusX);
    const py = Math.round(cy + Math.sin(angle) * radiusY);
    const isBack = Math.sin(angle) < 0;
    ctx.globalAlpha = (isBack ? 0.55 : 0.85) * lerp(0.75, 1.0, intensity);
    ctx.fillStyle = isBack ? '#c9a227' : '#ffd700';
    ctx.fillRect(px, py, pxSize, pxSize);
  }
  // Glint pixel circling the ring.
  const glintAngle = (t / AURA_HALO_GLINT_SEC) * Math.PI * 2;
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(
    Math.round(cx + Math.cos(glintAngle) * radiusX),
    Math.round(cy + Math.sin(glintAngle) * radiusY),
    pxSize,
    pxSize,
  );
  ctx.restore();
}

// ── Ember (Lv.25) ───────────────────────────────────────────
// Warm motes drifting up from the character's feet, swaying slightly and
// fading as they rise — a calm campfire drift, not roaring flames. Color
// cools from pale gold at birth to deep orange near the top.
function renderEmber(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  const pxSize = zoom;
  const count = Math.round(lerp(7, 11, intensity));
  const riseH = h * lerp(0.7, 1.0, intensity);
  const alphaScale = lerp(0.9, 1.0, intensity);

  ctx.save();
  ctx.shadowBlur = pxSize * 2;
  drawEmberMotes(ctx, t, x, w, y + h, riseH, count, AURA_EMBER_RISE_SEC, pxSize, alphaScale);
  ctx.restore();
}

// ── Prism (Lv.35) ───────────────────────────────────────────
// The sparkle twinkles, but each glint slowly drifts through a pastel color
// wheel — same calm pulse-in-place shapes, now prismatic.
function renderPrism(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  renderTwinkles(ctx, x, y, w, h, zoom, t, intensity, 8, 12, (i) => {
    const hue = ((t / AURA_PRISM_HUE_DRIFT_SEC) * 360 + i * 36) % 360;
    return {
      dim: `hsl(${hue}, 90%, 70%)`,
      bright: `hsl(${hue}, 55%, 88%)`,
      shadow: `hsl(${hue}, 100%, 60%)`,
    };
  });
}

// ── Static (Lv.40) ──────────────────────────────────────────
// Crisp electric ticks: a brief burst every interval draws a few short
// 3–4 pixel dashes at random points just outside the sprite silhouette,
// then nothing until the next burst. No bolts, no full-body flash — the
// character crackles quietly with charge.
function renderStatic(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  const pxSize = zoom;
  const burstInterval = lerp(AURA_STATIC_BURST_SLOW_SEC, AURA_STATIC_BURST_FAST_SEC, intensity);
  const burstPhase = t % burstInterval;
  if (burstPhase > AURA_STATIC_FLASH_SEC) return;

  const fade = 1 - burstPhase / AURA_STATIC_FLASH_SEC;
  const burstSeed = Math.floor(t / burstInterval) * 37;
  const ticks = Math.round(lerp(2, 4, intensity));

  ctx.save();
  ctx.shadowBlur = pxSize * 2;
  ctx.shadowColor = '#7fdfff';
  drawElectricTicks(
    ctx,
    x + w / 2,
    y + h * 0.55,
    w * 0.62,
    h * 0.58,
    pxSize,
    ticks,
    fade,
    burstSeed,
  );
  ctx.restore();
}

// ── Galaxy (Lv.50) ──────────────────────────────────────────
// Hitting the old level cap makes the agent the center of their own galaxy:
// three spiral arms of stardust swirl around the body in a flattened disc,
// anchored by bright guardian stars orbiting against the spin, with a comet
// streaking past. The milestone tier — denser and more alive than anything
// below it.
function renderGalaxy(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  const pxSize = zoom;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const spin = (t / AURA_GALAXY_ROTATE_SEC) * Math.PI * 2;

  ctx.save();

  // Spiral stardust disc — three arms swirling around the body, teal / pale
  // gold / white grains shimmering as they orbit.
  const arms = 3;
  const perArm = Math.round(lerp(6, 9, intensity));
  for (let a = 0; a < arms; a++) {
    for (let k = 0; k < perArm; k++) {
      const prog = k / perArm; // 0 = inner, 1 = rim
      const angle = spin + (a / arms) * Math.PI * 2 + prog * 2.2; // spiral twist
      const radius = w * 0.45 + prog * w * lerp(0.55, 0.75, intensity);
      const seed = a * 31.7 + k * 7.3;
      const shimmer = 0.6 + 0.4 * Math.sin(t * 2.5 + seed);
      ctx.globalAlpha = (1 - prog * 0.55) * shimmer * lerp(0.8, 1, intensity);
      const tone = seeded(seed);
      ctx.fillStyle = tone < 0.35 ? '#7df9e0' : tone < 0.7 ? '#ffe9a8' : '#ffffff';
      ctx.fillRect(
        Math.round(cx + Math.cos(angle) * radius),
        Math.round(cy + Math.sin(angle) * radius * 0.45),
        pxSize,
        pxSize,
      );
    }
  }

  // Guardian stars — large four-point stars orbiting against the dust spin,
  // drawn with the shared pixel-star glyph (same shape language as sparkle).
  ctx.shadowBlur = pxSize * 3;
  ctx.shadowColor = '#9ffce9';
  const guardians = Math.round(lerp(2, 3, intensity));
  for (let g = 0; g < guardians; g++) {
    const angle = -spin * 1.6 + (g / guardians) * Math.PI * 2;
    const px = Math.round(cx + Math.cos(angle) * w * 0.72);
    const py = Math.round(cy + Math.sin(angle) * h * 0.42);
    const tw = 0.7 + 0.3 * Math.sin(t * 3 + g * 2.1);
    drawPixelStar(ctx, px, py, pxSize, tw, 1.0, '#ffffff', '#9ffce9');
  }

  // Comet: every few seconds a shooting star streaks over the head.
  const cometPhase = (t % AURA_GALAXY_COMET_SEC) / 0.5; // 0.5s flight
  if (cometPhase < 1) {
    const cometSeed = Math.floor(t / AURA_GALAXY_COMET_SEC) * 17;
    const dir = seeded(cometSeed) > 0.5 ? 1 : -1;
    const cometX = cx - dir * w * 1.2 + dir * w * 2.4 * cometPhase;
    const cometY = y - pxSize * (4 + seeded(cometSeed + 1) * 3);
    for (let s = 0; s < 5; s++) {
      ctx.globalAlpha = (1 - cometPhase) * (1 - s * 0.18);
      ctx.fillStyle = s === 0 ? '#ffffff' : '#cfe0ff';
      ctx.fillRect(
        Math.round(cometX - dir * s * pxSize),
        Math.round(cometY + s * pxSize * 0.3),
        pxSize,
        pxSize,
      );
    }
  }
  ctx.restore();
}

// ── Storm (Lv.65) ───────────────────────────────────────────
// The air crackles with charge: a cyan ring of energy orbits the agent's feet,
// electric ticks snap around the body, and ground arcs leap across the ring.
// First tier of the "spectacle" arc — the agent is visibly radiating power.
function renderStorm(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  const pxSize = zoom;
  const cx = x + w / 2;
  const feetY = y + h - pxSize;
  const ringRX = w * lerp(0.7, 0.95, intensity);
  const ringRY = ringRX * 0.32;

  ctx.save();
  ctx.shadowBlur = pxSize * 2;
  ctx.shadowColor = '#7fdfff';

  // Charged ground ring — pixels orbiting the feet, dimmer behind the body.
  const dots = 12;
  const spin = (t / AURA_STORM_RING_ROTATE_SEC) * Math.PI * 2;
  for (let i = 0; i < dots; i++) {
    const angle = spin + (i / dots) * Math.PI * 2;
    const behind = Math.sin(angle) < 0;
    ctx.globalAlpha = (behind ? 0.4 : 0.85) * lerp(0.8, 1, intensity);
    ctx.fillStyle = i % 3 === 0 ? '#ffffff' : '#7fdfff';
    ctx.fillRect(
      Math.round(cx + Math.cos(angle) * ringRX),
      Math.round(feetY + Math.sin(angle) * ringRY),
      pxSize,
      pxSize,
    );
  }

  // Burst window: body crackles + a ground arc leaping across the ring.
  const burstInterval = lerp(AURA_STORM_ARC_SLOW_SEC, AURA_STORM_ARC_FAST_SEC, intensity);
  const burstPhase = t % burstInterval;
  if (burstPhase < AURA_STORM_ARC_FLASH_SEC) {
    const fade = 1 - burstPhase / AURA_STORM_ARC_FLASH_SEC;
    const burstSeed = Math.floor(t / burstInterval) * 53;

    const ticks = Math.round(lerp(3, 5, intensity));
    drawElectricTicks(ctx, cx, y + h * 0.5, w * 0.6, h * 0.5, pxSize, ticks, fade, burstSeed);

    // Ground arc: a zigzag of pixels jumping between opposite ring points.
    const arcAngle = seeded(burstSeed + 99) * Math.PI * 2;
    const x0 = cx + Math.cos(arcAngle) * ringRX;
    const y0 = feetY + Math.sin(arcAngle) * ringRY;
    const x1 = cx - Math.cos(arcAngle) * ringRX;
    const y1 = feetY - Math.sin(arcAngle) * ringRY;
    const segs = 6;
    let lx = x0;
    let ly = y0;
    ctx.fillStyle = '#d6f4ff';
    ctx.globalAlpha = fade * 0.9;
    for (let s = 1; s <= segs; s++) {
      const f = s / segs;
      const nx = x0 + (x1 - x0) * f + (seeded(burstSeed + s) - 0.5) * pxSize * 3;
      const ny = y0 + (y1 - y0) * f + (seeded(burstSeed + s + 40) - 0.5) * pxSize * 2;
      const steps = Math.max(1, Math.round(Math.hypot(nx - lx, ny - ly) / pxSize));
      for (let q = 0; q <= steps; q++) {
        const qf = q / steps;
        ctx.fillRect(
          Math.round(lx + (nx - lx) * qf),
          Math.round(ly + (ny - ly) * qf),
          pxSize,
          pxSize,
        );
      }
      lx = nx;
      ly = ny;
    }
  }
  ctx.restore();
}

// ── Phoenix (Lv.80) ─────────────────────────────────────────
// A full flame mantle: flickering fire tongues hug the agent's sides, bright
// embers shower upward, and fiery wing flares sweep out from the shoulders in
// rhythmic pulses. Reads as barely-contained power, shaped — not noisy.
function renderPhoenix(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  const pxSize = zoom;
  const baseY = y + h;

  ctx.save();

  // Flame mantle — four flickering tongues along the sprite's flanks. Drawn
  // WITHOUT shadowBlur: ~80 blurred fillRects per frame is the canvas slow
  // path, and the color ramp reads as fire on its own.
  const tongues = [
    { ox: -pxSize * 2.5, ph: 0 },
    { ox: w + pxSize * 1.5, ph: 1.7 },
    { ox: -pxSize * 4.5, ph: 3.1 },
    { ox: w + pxSize * 3.5, ph: 4.4 },
  ];
  for (const tongue of tongues) {
    const flick = 0.75 + 0.25 * Math.sin(t * Math.PI * 2 * AURA_PHOENIX_FLICKER_HZ + tongue.ph);
    const colH = h * lerp(0.45, 0.7, intensity) * flick;
    const rows = Math.max(2, Math.round(colH / pxSize));
    const fx = x + tongue.ox;
    for (let r = 0; r < rows; r++) {
      const prog = r / rows;
      const wob = prog > 0.4 ? Math.round(Math.sin(t * 5 + tongue.ph + r * 0.8) * pxSize) : 0;
      const color =
        prog < 0.25 ? '#ffd24a' : prog < 0.55 ? '#ff8a2a' : prog < 0.8 ? '#e0481f' : '#7a1f10';
      ctx.globalAlpha = (1 - prog * 0.6) * lerp(0.85, 1, intensity);
      ctx.fillStyle = color;
      ctx.fillRect(
        Math.round(fx + wob),
        Math.round(baseY - r * pxSize),
        prog < 0.3 ? pxSize * 2 : pxSize,
        pxSize,
      );
    }
  }

  // Ember shower — the shared ember field, faster than the Lv.25 tier.
  ctx.shadowBlur = pxSize * 2;
  drawEmberMotes(
    ctx,
    t,
    x - pxSize * 3,
    w + pxSize * 6,
    baseY,
    h * 1.25,
    8,
    AURA_PHOENIX_EMBER_RISE_SEC,
    pxSize,
    1.0,
  );

  // Wing flares — angled runs of fire sweeping out from the shoulders.
  ctx.shadowBlur = pxSize * 3;
  ctx.shadowColor = '#ff7a22';
  const wingPhase = (t % AURA_PHOENIX_WING_SEC) / AURA_PHOENIX_WING_SEC;
  if (wingPhase < 0.45) {
    const spread = Math.sin((wingPhase / 0.45) * Math.PI); // 0 → 1 → 0
    const shoulderY = y + h * 0.35;
    const len = Math.round(lerp(4, 7, intensity) * spread);
    for (let s = 0; s < len; s++) {
      ctx.globalAlpha = (1 - s / Math.max(1, len)) * spread;
      ctx.fillStyle = s < 2 ? '#ffd24a' : '#ff8a2a';
      const dy = Math.round(shoulderY - s * pxSize * 0.6);
      ctx.fillRect(Math.round(x - (3 + s) * pxSize), dy, pxSize, pxSize);
      ctx.fillRect(Math.round(x + w + (2 + s) * pxSize), dy, pxSize, pxSize);
    }
  }
  ctx.restore();
}

// ── Ascendant (Lv.100) ──────────────────────────────────────
// Final form. Prismatic rays rotate behind the agent, pillars of light rise at
// their back, a twin runic sigil counter-rotates at their feet, a gold crown
// floats above their head, and a radiant ring pulses outward — unmistakable
// from across the office.
function renderAscendant(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  t: number,
  intensity: number,
): void {
  const pxSize = zoom;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const feetY = y + h - pxSize;

  ctx.save();

  // 1. Prismatic rays — slow-rotating pixel beams radiating from the body.
  //    (No shadowBlur here: ~50 blurred rects per frame is real cost.)
  const rays = 8;
  const raySpin = (t / AURA_ASCENDANT_RAY_ROTATE_SEC) * Math.PI * 2;
  for (let i = 0; i < rays; i++) {
    const angle = raySpin + (i / rays) * Math.PI * 2;
    const hue = (i * 45 + t * 20) % 360;
    ctx.fillStyle = `hsl(${hue}, 70%, 80%)`;
    for (let s = 4; s < 10; s++) {
      ctx.globalAlpha = (1 - s / 12) * lerp(0.4, 0.55, intensity);
      ctx.fillRect(
        Math.round(cx + Math.cos(angle) * s * pxSize * 1.4),
        Math.round(cy + Math.sin(angle) * s * pxSize * 1.1),
        pxSize,
        pxSize,
      );
    }
  }

  // 2. Pillars of light rising behind the sprite.
  ctx.fillStyle = '#fff3c0';
  for (let p = 0; p < 3; p++) {
    const px = Math.round(x + (p + 0.5) * (w / 3));
    const phase = (t / 2.4 + p * 0.33) % 1;
    const rows = Math.round((h * 1.2 * Math.sin(phase * Math.PI)) / (pxSize * 2));
    for (let r = 0; r < rows; r++) {
      ctx.globalAlpha = (1 - r / Math.max(1, rows)) * 0.3;
      ctx.fillRect(px, Math.round(feetY - r * pxSize * 2), pxSize, pxSize);
    }
  }

  // 3. Twin runic sigil — counter-rotating dashed rings at the feet.
  const sigilSpin = (t / AURA_ASCENDANT_SIGIL_ROTATE_SEC) * Math.PI * 2;
  const sigilRings = [
    { r: w * 0.85, dir: 1, color: '#ffd700' },
    { r: w * 1.1, dir: -1, color: '#fff3c0' },
  ];
  for (const ring of sigilRings) {
    const slots = 16;
    ctx.fillStyle = ring.color;
    for (let i = 0; i < slots; i++) {
      if (i % 2 === 0) continue; // dashed
      const angle = sigilSpin * ring.dir + (i / slots) * Math.PI * 2;
      ctx.globalAlpha = Math.sin(angle) < 0 ? 0.45 : 0.85;
      ctx.fillRect(
        Math.round(cx + Math.cos(angle) * ring.r),
        Math.round(feetY + Math.sin(angle) * ring.r * 0.3),
        pxSize,
        pxSize,
      );
    }
  }

  // 4. Floating crown with a twinkling gem.
  ctx.shadowBlur = pxSize * 2;
  ctx.shadowColor = '#ffd700';
  const crownY = Math.round(y - pxSize * 5 + Math.sin(t * 2) * pxSize * 0.5);
  const crownX = Math.round(cx - pxSize * 2.5);
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = '#ffd700';
  ctx.fillRect(crownX, crownY, pxSize * 5, pxSize); // band
  ctx.fillRect(crownX, crownY - pxSize, pxSize, pxSize); // left point
  ctx.fillRect(crownX + pxSize * 4, crownY - pxSize, pxSize, pxSize); // right point
  ctx.fillRect(Math.round(cx - pxSize / 2), crownY - pxSize * 2, pxSize, pxSize * 2); // center point
  ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 3);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(cx - pxSize / 2), crownY - pxSize, pxSize, pxSize); // gem

  // 5. Radiant pulse — an expanding ring of light every few seconds.
  const pulsePhase = (t % AURA_ASCENDANT_PULSE_SEC) / 0.6;
  if (pulsePhase < 1) {
    const pulseR = pulsePhase * w * lerp(1.3, 1.6, intensity);
    const dots = 20;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = (1 - pulsePhase) * 0.7;
    for (let i = 0; i < dots; i++) {
      const angle = (i / dots) * Math.PI * 2;
      ctx.fillRect(
        Math.round(cx + Math.cos(angle) * pulseR),
        Math.round(cy + Math.sin(angle) * pulseR * 0.8),
        pxSize,
        pxSize,
      );
    }
  }
  ctx.restore();
}
