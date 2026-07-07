import { Matrix, EigenvalueDecomposition } from "ml-matrix";

// --- Spike Trains view: real-time motor-unit source decomposition from 3-ch sEMG.
// Design rationale + honesty caveat: docs/adr/0003-spike-trains-view-design.md
//
// IMPORTANT (honest labeling): true motor-unit decomposition assumes an HD-sEMG grid
// (64+ channels). A 3-channel armband lacks the spatial redundancy to resolve individual
// motor units, so the rows below are PUTATIVE motor unit sources — the output of the
// identical HD-sEMG math (delay extension + whitening + fastICA + peak/K-means + SIL) run
// on a spatially under-resolved input. Same algorithm, worse input; not physiological MUs.

// ponytail: all tuning knobs — starting values, retune against real recordings.
const FS = 834; // Hz, Mudra Link nominal sample rate
const BP_LOW = 20, BP_HIGH = 150; // Hz — MUAP main band (single-channel deconvolution ~90%-correlation band)
const R = 16; // time-delay extension order → ch*R effective dims (48 for 3 ch)
const MAX_SOURCES = 12; // deflation cap = max display rows (fewer accepted → empty slots at the top)
const REFRACTORY_MS = 20; // min inter-spike interval (physiological MUs ~3–11 pps)
const RATE_HANN_MS = 400; // firing-rate smoothing kernel full-width
const DISPLAY_SEC = 3; // scroll window, matches the Time view
const SIL_MIN = 0.90; // source-quality gate: reject sources whose spike/noise silhouette is below this
const FASTICA_MAX_ITER = 100;
const FASTICA_TOL = 1e-4;
const EIG_KEEP = 1e-4; // whitening: drop eigenvalues below this fraction of the max (rank reduction)
const TOTAL_CEIL_PPS = 240; // total-rate background line full-scale (tall ceiling → gentle 1/3-height trace)

const PALETTE = ["#2563eb", "#0f9d58", "#c026d3", "#c96442", "#d99a2b", "#0891b2", "#7c3aed", "#be123c", "#16a34a", "#db2777", "#4f46e5", "#ca8a04"];
const PAGE_BG = "#f5f4ee"; // matches index.html body — label chips sit on it so text stays legible over ticks

// --- Pure signal-processing helpers (exported for the self-check at the bottom) ---

// RBJ constant-skirt band-pass biquad coefficients (a0-normalized). ponytail: single 2nd-order
// biquad — cascade HP@low + LP@high if the passband edges matter.
export function makeBandpass(low: number, high: number, fs: number) {
  const f0 = Math.sqrt(low * high);
  const w0 = (2 * Math.PI * f0) / fs;
  const bw = Math.log2(high / low);
  const alpha = Math.sin(w0) * Math.sinh((Math.LN2 / 2) * bw * (w0 / Math.sin(w0)));
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}
type Biquad = ReturnType<typeof makeBandpass>;
interface BiquadState { x1: number; x2: number; y1: number; y2: number; }
const zeroState = (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 });
function biquadStep(c: Biquad, s: BiquadState, x: number): number {
  const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
  s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
  return y;
}

// 1-D 2-means on positive peak heights: lo cluster = noise, hi cluster = spikes. Threshold = midpoint.
export function kmeans2(vals: number[]): { lo: number; hi: number } | null {
  if (vals.length < 4) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi <= lo) return null;
  for (let it = 0; it < 50; it++) {
    let sl = 0, nl = 0, sh = 0, nh = 0;
    for (const v of vals) {
      if (Math.abs(v - lo) <= Math.abs(v - hi)) { sl += v; nl++; } else { sh += v; nh++; }
    }
    if (!nl || !nh) break;
    const nlo = sl / nl, nhi = sh / nh;
    if (Math.abs(nlo - lo) < 1e-12 && Math.abs(nhi - hi) < 1e-12) { lo = nlo; hi = nhi; break; }
    lo = nlo; hi = nhi;
  }
  return { lo, hi };
}

// Silhouette of the 2-cluster split (center-distance proxy — ponytail: cheap, swap for full
// pairwise silhouette if source acceptance is unreliable).
export function silhouette(vals: number[], lo: number, hi: number): number {
  let s = 0, n = 0;
  for (const v of vals) {
    const own = Math.abs(v - lo) <= Math.abs(v - hi) ? lo : hi;
    const oth = own === lo ? hi : lo;
    const a = Math.abs(v - own), b = Math.abs(v - oth), m = Math.max(a, b);
    if (m > 0) { s += (b - a) / m; n++; }
  }
  return n ? s / n : 0;
}

const dot = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

interface Source { wproj: Float64Array; thr: number; } // wproj·(ext−mean) = source; thr on squared source

// --- View ---

export function createSpikesView(canvas: HTMLCanvasElement) {
  const bp = makeBandpass(BP_LOW, BP_HIGH, FS);
  const refrSamp = Math.round((REFRACTORY_MS / 1000) * FS);
  const winSamp = DISPLAY_SEC * FS;
  const hannHalf = Math.round((RATE_HANN_MS / 1000) * FS / 2); // half-width in samples
  const hannNorm = hannHalf / FS; // ∫Hanning dt (s) → rate in pps

  // Learned (cached for the session, cleared only by a fresh learn):
  let ch = 0;
  let mean: Float64Array | null = null;
  let sources: Source[] = [];
  let ready = false;

  // Live signal state (cleared on reset / tab open):
  let bpState: BiquadState[] = []; // per channel
  let delay: Float64Array[] = []; // per channel, ring of last R filtered samples
  let dHead = 0;
  let nSamp = 0; // global fed-sample counter (drives the time axis)
  let sqPrev1: Float64Array = new Float64Array(0); // per source, squared source at n-1
  let sqPrev2: Float64Array = new Float64Array(0); // per source, squared source at n-2
  let lastSpike: Int32Array = new Int32Array(0); // per source, sample index of last spike
  let spikes: number[][] = []; // per source, sample indices within the display window

  function resetLive() {
    bpState = Array.from({ length: ch }, zeroState);
    delay = Array.from({ length: ch }, () => new Float64Array(R));
    dHead = 0;
    nSamp = 0;
    sqPrev1 = new Float64Array(sources.length);
    sqPrev2 = new Float64Array(sources.length);
    lastSpike = new Int32Array(sources.length).fill(-1e9);
    spikes = sources.map(() => []);
  }

  // Decompose the concatenated fixtures once → W (as per-source wproj) + frozen thresholds.
  // fixtures: array of recordings, each [channel][sample] of raw counts (same representation the
  // live feed delivers, so learned thresholds transfer).
  function learnW(fixtures: number[][][]) {
    ch = fixtures[0].length;
    const D = ch * R;

    // 1. band-pass each fixture per channel (fresh state → boundary transients stay per-fixture),
    //    then build per-channel delay-extended vectors (skip the first R−1 warm-up samples).
    const ext: Float64Array[] = [];
    for (const fx of fixtures) {
      const filt = fx.map((chData) => {
        const st = zeroState();
        return chData.map((x) => biquadStep(bp, st, x));
      });
      const n = filt[0].length;
      for (let t = R - 1; t < n; t++) {
        const v = new Float64Array(D);
        for (let c = 0; c < ch; c++) for (let d = 0; d < R; d++) v[c * R + d] = filt[c][t - d];
        ext.push(v);
      }
    }
    const N = ext.length;
    if (N < D + 1) { ready = false; return; }

    // 2. center
    const m = new Float64Array(D);
    for (const v of ext) for (let i = 0; i < D; i++) m[i] += v[i];
    for (let i = 0; i < D; i++) m[i] /= N;
    for (const v of ext) for (let i = 0; i < D; i++) v[i] -= m[i];

    // 3. covariance (D×D) → eigendecomposition → whitening rows (drop tiny eigenvalues = rank reduce)
    const cov: number[][] = Array.from({ length: D }, () => new Array(D).fill(0));
    for (const v of ext) for (let i = 0; i < D; i++) { const vi = v[i]; for (let j = i; j < D; j++) cov[i][j] += vi * v[j]; }
    for (let i = 0; i < D; i++) for (let j = i; j < D; j++) { cov[i][j] /= N; cov[j][i] = cov[i][j]; }
    const evd = new EigenvalueDecomposition(new Matrix(cov));
    const evals = evd.realEigenvalues;
    const evecs = evd.eigenvectorMatrix; // columns are eigenvectors
    const maxEig = Math.max(...evals);
    const wh: Float64Array[] = []; // whitening rows (D' × D): e_k^T / sqrt(λ_k)
    for (let k = 0; k < D; k++) {
      if (evals[k] <= 0 || evals[k] < maxEig * EIG_KEEP) continue;
      const inv = 1 / Math.sqrt(evals[k]);
      const row = new Float64Array(D);
      for (let j = 0; j < D; j++) row[j] = evecs.get(j, k) * inv;
      wh.push(row);
    }
    const Dp = wh.length;

    // 4. whiten all samples: z_i = Wh (x_i − mean)
    const Z: Float64Array[] = ext.map((v) => {
      const z = new Float64Array(Dp);
      for (let k = 0; k < Dp; k++) z[k] = dot(wh[k], v);
      return z;
    });

    // 5. fastICA with deflation (cubic contrast). ponytail: kurtosis nonlinearity; swap for the
    //    CoV-of-ISI refinement (EMGdecomPy) if putative-source quality is poor.
    const W: Float64Array[] = [];
    for (let s = 0; s < MAX_SOURCES; s++) {
      let w = new Float64Array(Dp);
      for (let k = 0; k < Dp; k++) w[k] = Math.random() - 0.5;
      normalize(w);
      for (let it = 0; it < FASTICA_MAX_ITER; it++) {
        const wNew = new Float64Array(Dp);
        for (const z of Z) { const g = dot(w, z); const g3 = g * g * g; for (let k = 0; k < Dp; k++) wNew[k] += z[k] * g3; }
        for (let k = 0; k < Dp; k++) wNew[k] = wNew[k] / N - 3 * w[k];
        for (const prev of W) { const p = dot(wNew, prev); for (let k = 0; k < Dp; k++) wNew[k] -= p * prev[k]; }
        normalize(wNew);
        const conv = Math.abs(dot(wNew, w));
        w = wNew;
        if (conv > 1 - FASTICA_TOL) break;
      }
      W.push(w);
    }

    // 6. per source: square → peaks → K-means(spike/noise) → SIL gate → accept + freeze threshold
    const accepted: Source[] = [];
    for (const w of W) {
      const heights: number[] = [];
      let sqm1 = 0, sqm2 = 0;
      for (let i = 0; i < N; i++) {
        const g = dot(w, Z[i]); const sq = g * g;
        if (i >= 2 && sqm1 > sqm2 && sqm1 >= sq) heights.push(sqm1); // local max at i−1
        sqm2 = sqm1; sqm1 = sq;
      }
      const km = kmeans2(heights);
      if (!km) continue;
      const sil = silhouette(heights, km.lo, km.hi);
      if (sil < SIL_MIN || km.hi <= km.lo) continue;
      const wproj = new Float64Array(D);
      for (let k = 0; k < Dp; k++) { const wk = w[k]; const row = wh[k]; for (let j = 0; j < D; j++) wproj[j] += wk * row[j]; }
      accepted.push({ wproj, thr: (km.lo + km.hi) / 2 });
    }

    mean = m;
    sources = accepted;
    ready = accepted.length > 0;
    resetLive();
  }

  // One raw sample per channel (raw counts, same as feedBytes pushes). Projects → detects spikes.
  function feed(sample: number[]) {
    if (!ready || !mean) return;
    // band-pass + push into per-channel delay ring
    dHead = (dHead + 1) % R;
    for (let c = 0; c < ch; c++) delay[c][dHead] = biquadStep(bp, bpState[c], sample[c]);
    nSamp++;
    if (nSamp < R) return; // delay ring not full yet
    // build extended vector and project each source
    for (let s = 0; s < sources.length; s++) {
      const wproj = sources[s].wproj;
      let g = 0;
      for (let c = 0; c < ch; c++) { const ring = delay[c]; const base = c * R; for (let d = 0; d < R; d++) g += wproj[base + d] * (ring[(dHead - d + R) % R] - mean[base + d]); }
      const sq = g * g;
      // local max at n−1 above frozen threshold, respecting the refractory period
      if (sqPrev1[s] > sqPrev2[s] && sqPrev1[s] >= sq && sqPrev1[s] > sources[s].thr && (nSamp - 1) - lastSpike[s] >= refrSamp) {
        lastSpike[s] = nSamp - 1;
        const arr = spikes[s];
        arr.push(nSamp - 1);
        const cutoff = nSamp - winSamp;
        if (arr.length && arr[0] < cutoff) { let i = 0; while (i < arr.length && arr[i] < cutoff) i++; arr.splice(0, i); }
      }
      sqPrev2[s] = sqPrev1[s]; sqPrev1[s] = sq;
    }
  }

  // Hanning-kernel firing rate (pps) at sample time t from a sorted spike-time list.
  function rateAt(times: number[], t: number): number {
    let r = 0;
    for (const ts of times) {
      const dtau = ts - t;
      if (dtau > hannHalf) break; // times ascending; past the kernel
      if (dtau < -hannHalf) continue;
      r += 0.5 * (1 + Math.cos((Math.PI * dtau) / hannHalf));
    }
    return r / hannNorm;
  }

  function draw(status: string) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);

    if (!ready) {
      ctx.fillStyle = "#a5a294";
      ctx.font = `${14 * dpr}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText(status || "No motor unit sources", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }

    const rows = sources.length;
    const bandH = h / MAX_SOURCES; // fixed band height (≤ MAX_SOURCES bands); MU 1 pinned to the bottom
    const t0 = nSamp - winSamp; // left edge sample index
    const xOf = (t: number) => ((t - t0) / winSamp) * w;
    const step = 2 * dpr;
    ctx.font = `${11 * dpr}px system-ui`;

    // --- cumulative (total) rate as a light-grey background line spanning the whole plot, drawn
    // first so the MU bands overlay it — lets you read total-rate vs. raster correlation. ---
    ctx.beginPath();
    for (let px = 0; px <= w; px += step) {
      const t = t0 + (px / w) * winSamp;
      let rate = 0;
      for (let s = 0; s < rows; s++) rate += rateAt(spikes[s], t);
      rate = Math.min(TOTAL_CEIL_PPS, rate);
      const y = h - 2 * dpr - (rate / TOTAL_CEIL_PPS) * (h - 4 * dpr);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.strokeStyle = "#d4d2c8"; ctx.lineWidth = 4.5 * dpr; ctx.stroke();

    // --- MU bands, MU 1 at the very bottom (order reversed) ---
    for (let s = 0; s < rows; s++) {
      const color = PALETTE[s % PALETTE.length];
      const yTop = h - (s + 1) * bandH, yBot = yTop + bandH; // s=0 (MU 1) at the very bottom
      ctx.strokeStyle = "#e8e6dd"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, yTop); ctx.lineTo(w, yTop); ctx.stroke();
      // raster: full-band vertical ticks (rate shown only by the total background line)
      ctx.strokeStyle = color; ctx.lineWidth = dpr;
      ctx.beginPath();
      for (const t of spikes[s]) { const x = xOf(t); ctx.moveTo(x, yTop + 2 * dpr); ctx.lineTo(x, yBot - 2 * dpr); }
      ctx.stroke();
      // MU label: bold, vertically centered in the band, on a page-colored chip for legibility
      const label = `MU ${s + 1}`;
      ctx.font = `bold ${13 * dpr}px system-ui`;
      const tw = ctx.measureText(label).width;
      const lx = 8 * dpr, ly = (yTop + yBot) / 2;
      ctx.fillStyle = PAGE_BG;
      ctx.fillRect(lx - 3 * dpr, ly - 10 * dpr, tw + 6 * dpr, 20 * dpr);
      ctx.fillStyle = color;
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx, ly);
      ctx.textBaseline = "alphabetic";
      ctx.font = `${11 * dpr}px system-ui`;
    }
  }

  return {
    learnW,
    feed,
    draw,
    reset: resetLive, // tab open: clear live signal/display, keep cached W
    get ready() { return ready; },
  };
}

function normalize(w: Float64Array) {
  let n = 0; for (let i = 0; i < w.length; i++) n += w[i] * w[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < w.length; i++) w[i] /= n;
}

// --- Self-check (ponytail: one runnable check for the non-trivial math). Runs at dev startup
// (stripped from the production build) and standalone via `npx tsx`. Fails loudly if the
// spike/noise split or the band-pass breaks. ---
export function selfCheck() {
  // K-means/SIL: two well-separated clusters (noise ≈1, spikes ≈10) must split between them.
  const noise = Array.from({ length: 200 }, (_, i) => 0.8 + (i % 5) * 0.05);
  const spk = Array.from({ length: 40 }, (_, i) => 9.5 + (i % 5) * 0.1);
  const km = kmeans2([...noise, ...spk]);
  if (!km) throw new Error("spikes self-check: kmeans2 returned null");
  const thr = (km.lo + km.hi) / 2;
  if (!(thr > 1 && thr < 9.5)) throw new Error(`spikes self-check: threshold ${thr} not between clusters`);
  if (silhouette([...noise, ...spk], km.lo, km.hi) < SIL_MIN) throw new Error("spikes self-check: silhouette below gate for clean clusters");
  // Band-pass: attenuates DC, passes a mid-band tone. Feed a constant → output decays toward 0.
  const c = makeBandpass(BP_LOW, BP_HIGH, FS), st = zeroState();
  let last = 0; for (let i = 0; i < 2000; i++) last = biquadStep(c, st, 1);
  if (Math.abs(last) > 0.05) throw new Error(`spikes self-check: band-pass passes DC (${last})`);
  const st2 = zeroState(); let amp = 0;
  for (let i = 0; i < 2000; i++) { const y = biquadStep(c, st2, Math.sin((2 * Math.PI * 55 * i) / FS)); if (i > 1000) amp = Math.max(amp, Math.abs(y)); }
  if (amp < 0.3) throw new Error(`spikes self-check: band-pass kills the 55 Hz mid-band tone (${amp})`);
}
if (import.meta.env?.DEV) selfCheck();
