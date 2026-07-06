import type { MudrakaModule, Stream } from "mudraka";

// --- Spectrum (frequency-domain) view ---
export const SPEC_WINDOW = 512; // FFT size (pow2): 257 one-sided bins @ 834 Hz => ~1.63 Hz/bin, 0.6 s window
export const SPEC_BINS = SPEC_WINDOW / 2 + 1;
// Power view: linear µV² (0 baseline, power can't go negative); axis top autoscales to the peak (DC bin excluded), floored at SPEC_PWR_MIN_TOP so idle/noise frames stay flat.
const SPEC_PWR_MIN_TOP = 5e4; // µV² — tune: minimum (default) for the peak-held axis top
const SPEC_FLASH_MS = 900; // highlight fade duration when the peak-held axis top grows
const SPEC_PEAK_WIN_S = 10; // trailing window (s) over which the axis top holds its peak
const SPEC_SHRINK_TAU = 0.3; // s — exp time constant for shrinking the axis (~1 s settle; grow is instant)
// Lock-toggle icons (Material Design Icons, 24×24 viewBox paths) drawn via Path2D on the canvas.
const ICON_LOCK = new Path2D("M12 17a2 2 0 0 0 2-2a2 2 0 0 0-2-2a2 2 0 0 0-2 2a2 2 0 0 0 2 2m6-9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h1V6a5 5 0 0 1 5-5a5 5 0 0 1 5 5v2zm-6-5a3 3 0 0 0-3 3v2h6V6a3 3 0 0 0-3-3");
const ICON_UPDOWN = new Path2D("M10 8H6l6-6l6 6h-4v8h4l-6 6l-6-6h4z");

const PEAK_NB = SPEC_PEAK_WIN_S; // one bucket per second

// Overlaid one-sided power spectrum, all channels on one axis, pulled from the engine on demand each frame; owns axis-top animation + lock-icon hit-region, caller just wires DOM events via hitTest/toggleLock/locked.
export function createSpectrumView(canvas: HTMLCanvasElement, colors: string[]) {
  // Power axis top = bucketed sliding max (1 s buckets) over the trailing SPEC_PEAK_WIN_S window, floored at the default, so old transients age out and the scale settles back down.
  let specPeak = SPEC_PWR_MIN_TOP; // window-max target the displayed top chases
  let specTop = SPEC_PWR_MIN_TOP; // displayed axis top (instant up, eased down)
  let specTopT = 0; // performance.now() of the last specTop update (for eased-down dt)
  let specPeakFlash = 0; // performance.now() when specPeak last grew (drives the highlight fade)
  let specLocked = false; // lock icon: freeze the axis top at its current value (ignore new peaks)
  let lockBox = { x: 0, y: 0, w: 0, h: 0 }; // lock icon hit region in CSS px (set each draw)
  const peakBuckets = new Float32Array(PEAK_NB); // max power seen in each bucket
  let peakHead = 0; // index of the current (newest) bucket
  let peakHeadT = 0; // performance.now() when the current bucket started

  // Trailing-window max: age buckets forward by elapsed time (clearing vacated ones), fold in this frame's peak, and return max(default, all buckets) — old transients drop out after the window.
  function windowPeak(framePeak: number, now: number) {
    const bucketMs = (SPEC_PEAK_WIN_S / PEAK_NB) * 1000;
    if (!peakHeadT) peakHeadT = now;
    let adv = Math.floor((now - peakHeadT) / bucketMs);
    if (adv > 0) {
      peakHeadT += adv * bucketMs;
      if (adv > PEAK_NB) adv = PEAK_NB;
      for (let i = 0; i < adv; i++) { peakHead = (peakHead + 1) % PEAK_NB; peakBuckets[peakHead] = 0; }
    }
    if (framePeak > peakBuckets[peakHead]) peakBuckets[peakHead] = framePeak;
    let m = SPEC_PWR_MIN_TOP;
    for (let i = 0; i < PEAK_NB; i++) if (peakBuckets[i] > m) m = peakBuckets[i];
    return m;
  }

  function draw(M: MudrakaModule | null, specPtr: number, stream: Stream | null, ch: number, nominalRate: number) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${11 * dpr}px system-ui`;

    const res = stream ? stream.spectrumInto(specPtr) : null;
    const bins = res ? res.bins : 0;

    // Inset plot area so axes/labels don't hug the canvas edges and the whole trace is visible.
    const ML = 70 * dpr, MR = 12 * dpr, MT = 12 * dpr, MB = 22 * dpr;
    const x0 = ML, x1 = w - MR, pw = x1 - x0;
    const y0 = MT, y1 = h - MB, ph = y1 - y0;

    // mudraka 0.3.0 doesn't export Module.HEAPF32 (only HEAP32/HEAPU8), so view the shared wasm buffer ourselves — rebuilt each frame, cheap, and survives heap growth.
    const f32 = bins >= 2 ? new Float32Array(M!.HEAPU8.buffer, specPtr, ch * bins) : null;

    // Axis top: peak power this frame (DC bin k=0 excluded so a DC offset doesn't crush the rest), folded into the trailing-window max; growing triggers the flash.
    let framePeak = 0;
    if (f32) for (let c = 0; c < ch; c++) for (let k = 1; k < bins; k++) {
      const p = f32[c * bins + k];
      if (p > framePeak) framePeak = p;
    }
    const now = performance.now();
    // When locked, the axis top is frozen (no window update, no ease); otherwise it follows the target — instant up, eased down (~SPEC_SHRINK_TAU) so it glides smaller.
    if (!specLocked) {
      const prevPeak = specPeak;
      specPeak = windowPeak(framePeak, now); // target: trailing-window max
      if (specPeak > prevPeak) specPeakFlash = now; // top grew — trigger the highlight
      const dt = specTopT ? Math.min((now - specTopT) / 1000, 0.1) : 0;
      if (specPeak >= specTop) specTop = specPeak;
      else specTop += (specPeak - specTop) * (1 - Math.exp(-dt / SPEC_SHRINK_TAU));
    }
    specTopT = now; // always advance so dt stays sane across lock/unlock and tab pauses
    const top = specTop;
    const pY = (p: number) => y1 - (p / top) * ph; // power 0 -> baseline, top -> ceiling

    // power gridlines (Y): fixed 20k µV² steps from 0 plus the peak max (top) line, labels right-aligned in the left margin with the µV² unit.
    ctx.strokeStyle = "#e8e6dd";
    ctx.fillStyle = "#a5a294";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    const lx = x0 - 6 * dpr; // right edge for the y-axis labels
    const STEP = 2e4; // µV² per tick
    let step = STEP;
    while (top / step > 50) step += STEP; // ponytail: 20k grid; coarsen only if the peak overcrowds
    const line = (y: number) => { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); };
    for (let p = 0; p < top; p += step) {
      const y = pY(p);
      line(y);
      // skip the label if this tick sits too close to the top (peak) label
      if (y - y0 > 13 * dpr) ctx.fillText(`${fmtPwr(p)} µV²`, lx, y + 4 * dpr);
    }
    line(y0); // peak max line at the top of the plot

    // top-of-axis (peak max) label; flash a fading accent background right after the peak grows
    const topLabel = `${fmtPwr(top)} µV²`;
    const ty = y0 + 10 * dpr;
    const tw = ctx.measureText(topLabel).width;
    const flash = Math.max(0, 1 - (now - specPeakFlash) / SPEC_FLASH_MS);
    if (flash > 0) {
      ctx.fillStyle = rgba("#c96442", flash * 0.6);
      ctx.beginPath();
      ctx.roundRect(lx - tw - 4 * dpr, ty - 12 * dpr, tw + 8 * dpr, 17 * dpr, 3 * dpr);
      ctx.fill();
    }
    ctx.fillStyle = "#a5a294"; // text keeps its normal color; only the background flashes
    ctx.fillText(topLabel, lx, ty);
    ctx.textAlign = "left"; // restore for the labels below
    // lock icon (MDI) just left of the label — click toggles freezing the axis top (see hitTest)
    const s = 14 * dpr;
    const iconX = lx - tw - 6 * dpr - s; // left edge, sits left of the right-aligned label
    const iconY = ty - 12 * dpr;
    drawIcon(ctx, specLocked ? ICON_LOCK : ICON_UPDOWN, iconX, iconY, s, "#a5a294");
    lockBox = { x: (iconX - 3 * dpr) / dpr, y: (iconY - 2 * dpr) / dpr, w: (s + 6 * dpr) / dpr, h: (s + 4 * dpr) / dpr };

    // frequency ticks (X) — always drawn, even idle, using the engine's rate when streaming or the nominal Nyquist so the axis is present before a window fills.
    const nyq = (res ? res.rate_hz : nominalRate) / 2;
    ctx.strokeStyle = "#efece1";
    for (let hz = 0; hz < nyq; hz += 100) {
      const x = x0 + (hz / nyq) * pw;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      // 0 Hz sits on the y-axis — nudge its label inward so it clears the power labels
      ctx.fillText(`${hz} Hz`, hz === 0 ? x + 2 * dpr : x - 10 * dpr, y1 + 15 * dpr);
    }

    if (!f32) return; // spectrum disabled or window not yet full — just the grid + axis

    // curves: bin k of channel c at f32[c * bins + k] (channel-major float32)
    for (let c = 0; c < ch; c++) {
      ctx.strokeStyle = colors[c];
      ctx.lineWidth = dpr;
      ctx.beginPath();
      for (let k = 0; k < bins; k++) {
        const x = x0 + (k / (bins - 1)) * pw;
        const y = Math.max(y0, Math.min(y1, pY(f32[c * bins + k])));
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // fill under the curve: extend the same path down to the plot baseline, translucent color
      ctx.lineTo(x1, y1);
      ctx.lineTo(x0, y1);
      ctx.closePath();
      ctx.fillStyle = rgba(colors[c], 0.12);
      ctx.fill();
    }
  }

  return {
    draw,
    hitTest(x: number, y: number) {
      return x >= lockBox.x && x <= lockBox.x + lockBox.w && y >= lockBox.y && y <= lockBox.y + lockBox.h;
    },
    get lockBox() {
      return lockBox;
    },
    get locked() {
      return specLocked;
    },
    toggleLock() {
      specLocked = !specLocked;
    },
  };
}

// Power label with an SI prefix on the number, unit fixed at µV² ("50k", "5M", "1.2G") — prefixing the number, not the squared unit, keeps 1000-steps and avoids mV² ambiguity.
function fmtPwr(v: number) {
  const scale = (f: number, s: string) => (v / f >= 100 ? Math.round(v / f) : +(v / f).toFixed(1)) + s;
  if (v >= 1e9) return scale(1e9, "G");
  if (v >= 1e6) return scale(1e6, "M");
  if (v >= 1e3) return scale(1e3, "k");
  return String(Math.round(v));
}

// Draw a 24×24-viewBox icon path filled at (x,y) scaled to size s.
function drawIcon(ctx: CanvasRenderingContext2D, path: Path2D, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 24, s / 24);
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
}

// "#rrggbb" -> "rgba(r,g,b,a)" for the under-curve fills.
function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
