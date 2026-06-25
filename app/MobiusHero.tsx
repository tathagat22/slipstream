"use client";

import { useEffect, useRef } from "react";

/**
 * The Cheaper-Loop — a single continuous figure-8 (lemniscate) that reads the
 * whole product in one second: a fetch enters the right lobe expensive (fat,
 * dim, indigo), distills at the centre pinch (sheds tokens), and exits the left
 * lobe cheap (thin, bright, cyan) — then loops, forever.
 *
 * Pure Canvas 2D + one RAF loop. No particle field, no WebGL. Decorative only —
 * the real H1 stays DOM. Honours prefers-reduced-motion with a static frame.
 */

type Activity = { domain: string; saved: number; hit: boolean; at: number };
type ReelItem = { domain: string; raw?: number; distilled: number };

const INDIGO = "#818cf8"; // cold / raw / expensive
const CYAN = "#5eead4"; // distilled / cheap
const WHITE = "#eef2ff";

// Real, measured pairs (from the README) used when there's no live traffic yet.
const CURATED: ReelItem[] = [
  { domain: "en.wikipedia.org", raw: 44183, distilled: 5055 },
  { domain: "react.dev", raw: 38240, distilled: 4710 },
  { domain: "en.wikipedia.org", raw: 41441, distilled: 11206 },
  { domain: "developer.mozilla.org", raw: 29880, distilled: 3960 },
];

const TAU = Math.PI * 2;

/** Lemniscate of Bernoulli: figure-8 crossing itself at the origin. */
function lemniscate(t: number, a: number): { x: number; y: number } {
  const s = Math.sin(t);
  const c = Math.cos(t);
  const d = 1 + s * s;
  return { x: (a * c) / d, y: (a * s * c) / d };
}

function fmt(n: number) {
  return Math.round(n).toLocaleString();
}

// ---------------------------------------------------------------------------
// Arc-length LUT (module scope — computed once, never re-allocated).
//
// The lemniscate's arc-length per unit t is non-uniform: the chip travels
// ~1.41× faster at the lobe tips vs. the centre pinch under constant d(phase)/dt.
// We pre-integrate arc length into a 512-entry table (normalized to [0,1]) and
// invert it to reparameterize the chip's phase as a constant-speed arc fraction.
// ---------------------------------------------------------------------------
const ARC_LUT_N = 512;
const _arcLUT = new Float32Array(ARC_LUT_N + 1);
(function buildArcLUT() {
  let px = 1,
    py = 0; // lemniscate(0, 1)
  _arcLUT[0] = 0;
  for (let i = 1; i <= ARC_LUT_N; i++) {
    const t = (i / ARC_LUT_N) * TAU;
    const s = Math.sin(t),
      c = Math.cos(t),
      d = 1 + s * s;
    const qx = c / d,
      qy = (s * c) / d;
    const dx = qx - px,
      dy = qy - py;
    _arcLUT[i] = _arcLUT[i - 1] + Math.sqrt(dx * dx + dy * dy);
    px = qx;
    py = qy;
  }
  // Normalize so arcLUT[ARC_LUT_N] === 1.
  const total = _arcLUT[ARC_LUT_N];
  for (let i = 0; i <= ARC_LUT_N; i++) _arcLUT[i] /= total;
})();

/**
 * Given arc fraction s ∈ [0,1], return the corresponding lemniscate parameter
 * t ∈ [0, TAU]. Binary search into the normalized LUT.
 */
function arcToT(s: number): number {
  let lo = 0,
    hi = ARC_LUT_N;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (_arcLUT[mid] <= s) lo = mid;
    else hi = mid;
  }
  const frac = (_arcLUT[lo + 1] - _arcLUT[lo]) === 0
    ? 0
    : (s - _arcLUT[lo]) / (_arcLUT[lo + 1] - _arcLUT[lo]);
  return ((lo + frac) / ARC_LUT_N) * TAU;
}

// ---------------------------------------------------------------------------
// Smooth blend helpers
// ---------------------------------------------------------------------------

/** Hermite smoothstep — zero first-derivative at both edges. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Cheap-blend for the token chip.  Returns 0 on the right lobe (raw/expensive),
 * 1 on the left lobe (distilled/cheap), with smooth S-curves at both crossings.
 *
 * W = half-window in t-radians.  0.45 rad ≈ 500 ms each side at a 7 s lap,
 * giving a natural anticipation ramp before the pinch and a clean exit after.
 */
function chipBlend(t: number): number {
  const PI = Math.PI;
  const W = 0.45;
  const a1 = PI / 2 - W,
    b1 = PI / 2 + W;
  const a2 = (3 * PI) / 2 - W,
    b2 = (3 * PI) / 2 + W;
  if (t < a1) return 0;
  if (t < b1) return smoothstep(a1, b1, t);
  if (t < a2) return 1;
  if (t < b2) return 1 - smoothstep(a2, b2, t);
  return 0;
}

/** Cubic ease-out: fast start, smooth deceleration to 1. */
function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
}

/** Lerp two hex colours by a 0..1 fraction, component-wise. */
function lerpHex(a: string, b: string, t: number): string {
  const parse = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const ca = parse(a),
    cb = parse(b);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

export default function MobiusHero({ activity }: { activity?: Activity[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activityRef = useRef<Activity[] | undefined>(activity);
  activityRef.current = activity;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    // ------------------------------------------------------------------
    // Offscreen canvas for the static duotone path.
    // The path only changes on resize; every other frame we blit it.
    // This moves the 200-segment stroke loop off the per-frame critical path.
    // ------------------------------------------------------------------
    const pathCanvas = document.createElement("canvas");
    const pCtx = pathCanvas.getContext("2d");

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      w = r.width;
      h = r.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Repaint the offscreen path at the new dimensions.
      rebuildPathCanvas();
    };

    const rebuildPathCanvas = () => {
      if (!pCtx) return;
      pathCanvas.width = Math.round(w * dpr);
      pathCanvas.height = Math.round(h * dpr);
      pCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cx = w / 2;
      const cy = h / 2;
      const a = Math.min(w * 0.46, h * 1.4);
      const base = Math.max(2, a * 0.018);

      pCtx.clearRect(0, 0, w, h);
      pCtx.lineCap = "round";
      pCtx.lineJoin = "round";

      const N = 200;
      for (let i = 0; i < N; i++) {
        const t0 = (i / N) * TAU;
        const t1 = ((i + 1) / N) * TAU;
        const p = lemniscate(t0, a);
        const q = lemniscate(t1, a);
        const right = Math.cos(t0) > 0;
        pCtx.beginPath();
        pCtx.moveTo(cx + p.x, cy + p.y);
        pCtx.lineTo(cx + q.x, cy + q.y);
        pCtx.lineWidth = base * (0.3 + 0.7 * Math.abs(Math.cos(t0)));
        pCtx.strokeStyle = right
          ? "rgba(129,140,248,0.6)"
          : "rgba(94,234,212,0.66)";
        pCtx.stroke();
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // Reel cursor + per-lap chip state.
    let idx = 0;
    const nextItem = (): ReelItem => {
      const live = activityRef.current?.filter((a) => a.saved > 0) ?? [];
      if (live.length) {
        const a = live[idx % live.length];
        idx++;
        return { domain: a.domain, distilled: a.saved };
      }
      const it = CURATED[idx % CURATED.length];
      idx++;
      return it;
    };
    let item = nextItem();

    // Small token "shed" ticks emitted at the distill pinch (max 6).
    // Stored as a flat typed array to avoid per-frame allocation:
    // [x, y, vx, vy, life] * 6 = 30 floats.  A sentinel life<=0 means slot is free.
    const TICK_COUNT = 6;
    const TICK_STRIDE = 5; // x,y,vx,vy,life
    const tickPool = new Float32Array(TICK_COUNT * TICK_STRIDE);
    // Initialise all slots as dead.
    for (let i = 0; i < TICK_COUNT; i++) tickPool[i * TICK_STRIDE + 4] = 0;

    const emitTicks = (cx: number, cy: number) => {
      for (let i = 0; i < TICK_COUNT; i++) {
        const ang = (i / TICK_COUNT) * TAU + (Math.random() - 0.5) * 0.8;
        const speed = 0.18 + Math.random() * 0.1; // px/ms
        const base = i * TICK_STRIDE;
        tickPool[base + 0] = cx;
        tickPool[base + 1] = cy;
        tickPool[base + 2] = Math.cos(ang) * speed;
        tickPool[base + 3] = Math.sin(ang) * speed - 0.06; // mild upward bias
        tickPool[base + 4] = 1; // life [0..1]
      }
    };

    const draw = (arcPhase: number, introT: number, distillGlow: number) => {
      const cx = w / 2;
      const cy = h / 2;
      const a = Math.min(w * 0.46, h * 1.4);
      const base = Math.max(2, a * 0.018);

      ctx.clearRect(0, 0, w, h);

      // --- Intro: trace the figure-8 into existence before anything travels it ---
      if (introT < 1) {
        const N = 200;
        const drawn = Math.max(1, Math.floor(N * introT));
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < drawn; i++) {
          const t0 = (i / N) * TAU;
          const t1 = ((i + 1) / N) * TAU;
          const p = lemniscate(t0, a);
          const q = lemniscate(t1, a);
          const right = Math.cos(t0) > 0;
          ctx.beginPath();
          ctx.moveTo(cx + p.x, cy + p.y);
          ctx.lineTo(cx + q.x, cy + q.y);
          ctx.lineWidth = base * (0.3 + 0.7 * Math.abs(Math.cos(t0)));
          ctx.strokeStyle = right
            ? "rgba(129,140,248,0.6)"
            : "rgba(94,234,212,0.66)";
          ctx.stroke();
        }
        // Bright pen-head leading the trace.
        const ht = (drawn / N) * TAU;
        const hp = lemniscate(ht, a);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.shadowColor = CYAN;
        ctx.shadowBlur = 18;
        ctx.fillStyle = WHITE;
        ctx.beginPath();
        ctx.arc(cx + hp.x, cy + hp.y, base * 1.1, 0, TAU);
        ctx.fill();
        ctx.restore();
        return; // hold chip/labels until the loop exists
      }

      // --- Blit the pre-rendered static path ---
      ctx.drawImage(pathCanvas, 0, 0, w, h);

      // --- Shimmer: a bright dash trailing the chip like a velocity wake ---
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.shadowColor = CYAN;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      const head = (arcToT(arcPhase % 1) - 0.35 + TAU) % TAU;
      for (let k = 0; k <= 28; k++) {
        const t = head + (k / 28) * 0.9;
        const p = lemniscate(t, a);
        if (k === 0) ctx.moveTo(cx + p.x, cy + p.y);
        else ctx.lineTo(cx + p.x, cy + p.y);
      }
      ctx.strokeStyle = "rgba(94,234,212,0.4)";
      ctx.lineWidth = base * 0.5;
      ctx.stroke();
      ctx.restore();

      // --- The travelling token (arc-length parameterized) ---
      const t = arcToT(arcPhase % 1);
      const pos = lemniscate(t, a);
      const px = cx + pos.x;
      const py = cy + pos.y;

      // Smooth blend 0=raw/right lobe  1=distilled/left lobe
      const blend = chipBlend(t);
      // Ease the blend through a cubic curve so the colour arrival is punchy
      const easedBlend = easeOutCubic(blend);

      const dotR = base * (1.5 + (1 - easedBlend) * 0.9); // fat→thin
      const col = lerpHex(INDIGO, CYAN, easedBlend);
      const shadowBlur = 14 + (easedBlend * 8); // brighten on left lobe

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.shadowColor = col;
      ctx.shadowBlur = shadowBlur;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, dotR, 0, TAU);
      ctx.fill();
      ctx.restore();

      // --- Shed ticks (drawn from typed pool, no array allocation) ---
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < TICK_COUNT; i++) {
        const base_i = i * TICK_STRIDE;
        const life = tickPool[base_i + 4];
        if (life <= 0) continue;
        // Ease-out opacity: starts at ~0.9, fades with cubic
        const alpha = easeOutCubic(life) * 0.9;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = WHITE;
        ctx.beginPath();
        ctx.arc(tickPool[base_i + 0], tickPool[base_i + 1], base * 0.5, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // --- Chip: domain + (collapsing) token count, on a real data pill ---
      const domain = item.domain;
      let big: string;
      if (easedBlend < 0.5) {
        // Right lobe / approaching pinch: show raw token count
        big = item.raw != null ? `${fmt(item.raw)} tok` : "fetching…";
      } else if (item.raw != null) {
        // Distilling / left lobe: morph the number raw→distilled
        const lerpT = easeOutCubic((easedBlend - 0.5) * 2);
        const v = item.raw + (item.distilled - item.raw) * lerpT;
        big = `${fmt(v)} tok`;
      } else {
        big = `+${fmt(item.distilled)} saved`;
      }

      const cheap = easedBlend > 0.5;
      const mono = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = "alphabetic";

      // Measure both lines to size the pill and keep it inside the canvas.
      ctx.font = `700 19px ${mono}`;
      const wNum = ctx.measureText(big).width;
      ctx.font = `600 13px ${mono}`;
      const wDom = ctx.measureText(domain).width;
      const padX = 13;
      const chipW = Math.max(wNum, wDom) + padX * 2;
      const chipH = 46;
      const gap = base * 1.4 + 12;
      // Inboard of the dot, then clamped so it never clips the edges.
      let chipX = pos.x >= 0 ? px - gap - chipW : px + gap;
      chipX = Math.max(8, Math.min(w - chipW - 8, chipX));
      let chipY = py - chipH / 2;
      chipY = Math.max(6, Math.min(h - chipH - 6, chipY));

      ctx.save();
      const rr = 11;
      ctx.beginPath();
      ctx.moveTo(chipX + rr, chipY);
      ctx.arcTo(chipX + chipW, chipY, chipX + chipW, chipY + chipH, rr);
      ctx.arcTo(chipX + chipW, chipY + chipH, chipX, chipY + chipH, rr);
      ctx.arcTo(chipX, chipY + chipH, chipX, chipY, rr);
      ctx.arcTo(chipX, chipY, chipX + chipW, chipY, rr);
      ctx.closePath();
      ctx.fillStyle = cheap ? "rgba(13,28,28,0.82)" : "rgba(16,18,32,0.82)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = cheap
        ? "rgba(94,234,212,0.55)"
        : "rgba(129,140,248,0.5)";
      ctx.stroke();

      ctx.textAlign = "left";
      const tx = chipX + padX;
      ctx.font = `600 13px ${mono}`;
      ctx.fillStyle = "rgba(206,214,238,0.9)";
      ctx.fillText(domain, tx, chipY + 19);
      ctx.font = `700 19px ${mono}`;
      ctx.fillStyle = cheap ? CYAN : "#dce2f2";
      ctx.fillText(big, tx, chipY + 38);
      ctx.restore();

      // --- Centre "distill" marker — flares at the moment of distillation ---
      ctx.font = `600 11px ${mono}`;
      ctx.textAlign = "center";
      ctx.save();
      ctx.fillStyle = `rgba(94,234,212,${0.32 + distillGlow * 0.6})`;
      ctx.shadowColor = CYAN;
      ctx.shadowBlur = distillGlow * 14;
      ctx.fillText("DISTILL", cx, cy + a * 0.42);
      ctx.restore();
    };

    if (reduce) {
      // Static frame: chip on the left lobe (t=PI ≈ arc fraction 0.5), distilled,
      // with the DISTILL marker lit so the still reads the whole story.
      draw(0.5, 1, 0.6);
      return () => ro.disconnect();
    }

    let raf = 0;
    let running = false;
    let last = performance.now();
    // arcPhase: 0..1 fraction of a full constant-speed lap.
    let arcPhase = 0;
    // prevBlend for detecting the distill crossing edge.
    let prevBlend = 0;
    const introStart = performance.now();
    let distillGlow = 0; // 1 at the flash, decays to 0
    const SPEED = 1 / 7000; // arc-fractions per ms (1 full lap / 7000 ms)
    const INTRO_MS = 850;

    const frame = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;

      // Trace the loop into existence first; hold the chip at the start until done.
      const introT = smoothstep(0, 1, (now - introStart) / INTRO_MS);
      if (introT >= 1) {
        arcPhase = (arcPhase + dt * SPEED) % 1;
      }
      distillGlow = Math.max(0, distillGlow - dt / 500);

      // Derive actual t for blend calculation (needed for crossing detection).
      const t = arcToT(arcPhase);
      const blend = chipBlend(t);

      // Distill event: fires when blend crosses 0.45 from below (slightly before
      // the geometric centre, giving a beat of anticipation that reads as intent).
      const crossedDistill = introT >= 1 && prevBlend < 0.45 && blend >= 0.45;
      // Reload event: fires when blend crosses back below 0.05 (right lobe re-entry).
      const crossedReload = prevBlend > 0.05 && blend <= 0.05;

      if (crossedDistill) {
        const chipX = w / 2 + lemniscate(t, Math.min(w * 0.46, h * 1.4)).x;
        const chipY = h / 2 + lemniscate(t, Math.min(w * 0.46, h * 1.4)).y;
        emitTicks(chipX, chipY);
        distillGlow = 1;
        // Let the DOM headline "feel" the distillation (caught in page.tsx).
        window.dispatchEvent(new CustomEvent("slip-distill"));
      }
      if (crossedReload) {
        item = nextItem();
      }
      prevBlend = blend;

      // Advance tick pool in-place (no array allocation).
      for (let i = 0; i < TICK_COUNT; i++) {
        const base = i * TICK_STRIDE;
        if (tickPool[base + 4] <= 0) continue;
        // Exponential drag: velocity decays toward zero, giving an ease-out arc.
        const drag = Math.pow(0.92, dt / 16.67);
        tickPool[base + 2] *= drag;
        tickPool[base + 3] *= drag;
        tickPool[base + 0] += tickPool[base + 2] * dt;
        tickPool[base + 1] += tickPool[base + 3] * dt;
        tickPool[base + 4] -= dt / 600;
      }

      draw(arcPhase, introT, distillGlow);
      raf = requestAnimationFrame(frame);
    };

    // ------------------------------------------------------------------
    // Visibility guard: pause RAF when the tab is hidden to save battery
    // and CPU. The animation resumes seamlessly when the tab becomes visible.
    // ------------------------------------------------------------------
    const onVisibility = () => {
      if (document.hidden) {
        if (running) {
          cancelAnimationFrame(raf);
          running = false;
        }
      } else {
        if (!running) {
          last = performance.now(); // reset dt to avoid a frame-time spike
          running = true;
          raf = requestAnimationFrame(frame);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    running = true;
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="mobius" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} className="mobiusCanvas" />
    </div>
  );
}
