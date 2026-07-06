import type { MudrakaModule, Stream } from "mudraka";
import { PCA } from "ml-pca";

// --- Manifold view: per-channel spectral features -> PCA -> point cloud + hull, 2D/3D.
// Design rationale: docs/adr/0002-manifold-view-design.md ---

// ponytail: placeholder log-spaced center frequencies — replace after reviewing real recorded-EMG spectra.
export const FEATURE_FREQS_HZ = [5, 8, 12, 18, 26, 38, 55, 80, 115, 165, 235, 335];
export const SAMPLE_INTERVAL_S = 0.1;
export const BUFFER_SIZE = 300;
export const PCA_REFIT_EVERY = 10;
export const TRANSITION_MS = 500;

const ACCENT = "#c96442";
const AXIS_LEN = 36; // px, fixed length so the reference axes read as a small gizmo, not scaled with the data spread
const PAGE_BG = "#f5f4ee"; // matches index.html's body/.lane-label background, so axis labels stay legible over the cloud
const DEPTH_SIZE_AMOUNT = 0.5; // Cube mode: point radius varies by depth
const DEPTH_FOG_AMOUNT = 0.5; // Cube mode: far items dim

const ICON_PLANE = new Path2D("M3,3H21V21H3V3M5,5V19H19V5H5Z");
const ICON_CUBE = new Path2D(
  "M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L6.04,7.5L12,10.85L17.96,7.5L12,4.15M5,15.91L11,19.29V12.58L5,9.21V15.91M19,15.91V9.21L13,12.58V19.29L19,15.91Z",
);

type Mode = "plane" | "cube";
type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Face = [number, number, number]; // vertex indices, CCW seen from outside

const AXES_2D: Array<{ label: string; dir: Vec2 }> = [
  { label: "PC1", dir: [1, 0] },
  { label: "PC2", dir: [0, 1] },
];
const AXES_3D: Array<{ label: string; dir: Vec3 }> = [
  { label: "PC1", dir: [1, 0, 0] },
  { label: "PC2", dir: [0, 1, 0] },
  { label: "PC3", dir: [0, 0, 1] },
];

interface Point {
  raw: number[]; // ch * FEATURE_FREQS_HZ.length feature vector
  proj: number[] | null; // current animated position (2 or 3 numbers)
  from: number[] | null;
  to: number[] | null;
  age: number; // samples since this point was added (drives the opacity fade)
}

// mel-filterbank-style triangular windows: half-width = distance to neighbors, so dense
// low-freq points stay narrow and sparse high-freq points smooth wider — no extra width param.
function filterbankWeights(binHz: number, bins: number): Array<Array<[number, number]>> {
  return FEATURE_FREQS_HZ.map((f0, i) => {
    const leftHalf = i > 0 ? (f0 - FEATURE_FREQS_HZ[i - 1]) / 2 : (FEATURE_FREQS_HZ[i + 1] - f0) / 2;
    const rightHalf =
      i < FEATURE_FREQS_HZ.length - 1 ? (FEATURE_FREQS_HZ[i + 1] - f0) / 2 : leftHalf;
    const kLo = Math.max(0, Math.ceil((f0 - leftHalf) / binHz));
    const kHi = Math.min(bins - 1, Math.floor((f0 + rightHalf) / binHz));
    const weights: Array<[number, number]> = [];
    for (let k = kLo; k <= kHi; k++) {
      const f = k * binHz;
      const half = f <= f0 ? leftHalf : rightHalf;
      const w = half > 0 ? Math.max(0, 1 - Math.abs(f - f0) / half) : 1;
      if (w > 0) weights.push([k, w]);
    }
    return weights;
  });
}

// f32 is channel-major (ch * bins), matching spectrum.ts's read of the same buffer.
function extractFeature(f32: Float32Array, ch: number, bins: number, binHz: number): number[] {
  const weights = filterbankWeights(binHz, bins);
  const out: number[] = [];
  for (let c = 0; c < ch; c++) {
    for (const w of weights) {
      let sum = 0, wsum = 0;
      for (const [k, wt] of w) { sum += f32[c * bins + k] * wt; wsum += wt; }
      out.push(wsum > 0 ? sum / wsum : 0);
    }
  }
  return out;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// Graham scan. Points are already in screen space, so the hull can be drawn directly.
function convexHull2D(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return [];
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Incremental (QuickHull-style) convex hull, no spatial acceleration — fine for a few-hundred-point cloud.
// ponytail: O(points * faces) rebuild every call; revisit only if profiling shows it's the bottleneck.
function convexHull3D(pts: Vec3[]): Face[] {
  const n = pts.length;
  if (n < 4) return [];

  // Seed tetrahedron: first 4 points found that aren't coplanar.
  let seed: [number, number, number, number] | null = null;
  outer: for (let a = 0; a < n && !seed; a++) {
    for (let b = a + 1; b < n && !seed; b++) {
      for (let c = b + 1; c < n && !seed; c++) {
        const nrm = cross3(sub3(pts[b], pts[a]), sub3(pts[c], pts[a]));
        if (dot3(nrm, nrm) < 1e-9) continue;
        for (let d = c + 1; d < n; d++) {
          if (Math.abs(dot3(nrm, sub3(pts[d], pts[a]))) > 1e-6) {
            seed = [a, b, c, d];
            break outer;
          }
        }
      }
    }
  }
  if (!seed) return []; // all points coplanar/degenerate — skip the fill this frame

  const hullCenter: Vec3 = [
    (pts[seed[0]][0] + pts[seed[1]][0] + pts[seed[2]][0] + pts[seed[3]][0]) / 4,
    (pts[seed[0]][1] + pts[seed[1]][1] + pts[seed[2]][1] + pts[seed[3]][1]) / 4,
    (pts[seed[0]][2] + pts[seed[1]][2] + pts[seed[2]][2] + pts[seed[3]][2]) / 4,
  ]; // interior to the seed tetrahedron, and stays interior as the hull only grows outward from it

  const makeFace = (i: number, j: number, k: number): Face => {
    const nrm = cross3(sub3(pts[j], pts[i]), sub3(pts[k], pts[i]));
    return dot3(nrm, sub3(pts[i], hullCenter)) < 0 ? [i, k, j] : [i, j, k];
  };
  const faceNormal = (f: Face): Vec3 => cross3(sub3(pts[f[1]], pts[f[0]]), sub3(pts[f[2]], pts[f[0]]));

  let faces: Face[] = [
    makeFace(seed[0], seed[1], seed[2]),
    makeFace(seed[0], seed[1], seed[3]),
    makeFace(seed[0], seed[2], seed[3]),
    makeFace(seed[1], seed[2], seed[3]),
  ];
  const used = new Set<number>(seed);

  for (let p = 0; p < n; p++) {
    if (used.has(p)) continue;
    const visible = faces.filter((f) => dot3(faceNormal(f), sub3(pts[p], pts[f[0]])) > 1e-9);
    if (visible.length === 0) continue; // p is inside the current hull

    // Horizon = edges of visible faces not shared with another visible face.
    const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    const edgeCount = new Map<string, number>();
    const edgesOf = (f: Face): Array<[number, number]> => [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]];
    for (const f of visible) for (const [a, b] of edgesOf(f)) {
      const k = edgeKey(a, b);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
    const horizon: Array<[number, number]> = [];
    for (const f of visible) for (const [a, b] of edgesOf(f)) {
      if (edgeCount.get(edgeKey(a, b)) === 1) horizon.push([a, b]);
    }

    faces = faces.filter((f) => !visible.includes(f));
    for (const [a, b] of horizon) faces.push(makeFace(a, b, p));
    used.add(p);
  }
  return faces;
}

// Non-trivial geometry, so it gets a runnable self-check (ponytail: assert, not a test file).
if (import.meta.env.DEV) {
  const cube: Vec3[] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    [0.5, 0.5, 0.5], // interior point — must not appear in the hull
  ];
  const faces = convexHull3D(cube);
  if (faces.length !== 12) throw new Error(`convexHull3D broken: expected 12 faces, got ${faces.length}`);
  const square = convexHull2D([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]]);
  if (square.length !== 4) throw new Error(`convexHull2D broken: expected 4 vertices, got ${square.length}`);
}

function rotate3(p: Vec3, yaw: number, pitch: number): Vec3 {
  const [x, y, z] = p;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;
  const cosX = Math.cos(pitch), sinX = Math.sin(pitch);
  const y2 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;
  return [x1, y2, z2];
}

function opacityForAge(age: number) {
  return Math.max(0.08, 1 - (age / BUFFER_SIZE) * 0.9);
}

function depthT(z: number, maxAbs: number) {
  return (Math.max(-1, Math.min(1, z / maxAbs)) + 1) / 2;
}

// "#rrggbb" -> "rgba(r,g,b,a)", duplicated from spectrum.ts per this codebase's per-view-utility convention.
function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Axis-tip label at (x, y), optionally on a page-background badge so it reads over the
// cloud. Badge only matters in Cube mode, where a point can sit in front of the label.
function drawAxisLabel(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, dpr: number, bg: boolean) {
  ctx.font = `${10 * dpr}px system-ui`;
  const lx = x + 3 * dpr, ly = y - 3 * dpr;
  if (bg) {
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = PAGE_BG;
    ctx.beginPath();
    ctx.roundRect(lx - 2 * dpr, ly - 9 * dpr, tw + 4 * dpr, 12 * dpr, 3 * dpr);
    ctx.fill();
  }
  ctx.fillStyle = "#a5a294";
  ctx.fillText(label, lx, ly);
}

// Draw a 24x24-viewBox icon path filled at (x,y) scaled to size s (same helper as spectrum.ts).
function drawIcon(ctx: CanvasRenderingContext2D, path: Path2D, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 24, s / 24);
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
}

export function createManifoldView(canvas: HTMLCanvasElement) {
  let mode: Mode = "plane";
  const points: Point[] = [];
  let pca: PCA | null = null;
  let samplesSinceRefit = 0;
  let lastSampleT = 0;
  let transitioning = false;
  let transitionStart = 0;
  let rotYaw = 0.5, rotPitch = 0.3; // ponytail: arbitrary starting angle, not derived from data
  let iconBox = { x: 0, y: 0, w: 0, h: 0 }; // mode icon hit region in CSS px (set each draw)

  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    rotYaw += (e.clientX - lastX) * 0.01;
    rotPitch = Math.max(-1.4, Math.min(1.4, rotPitch + (e.clientY - lastY) * 0.01));
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener("mouseup", () => { dragging = false; });

  function nComponents() {
    return mode === "cube" ? 3 : 2;
  }

  // animate=true tweens every point to the newly-fit position; animate=false (after a
  // mode switch) reprojects immediately since there's nothing sensible to interpolate from.
  function refit(animate: boolean) {
    const n = nComponents();
    if (points.length < n + 1) return;
    const raw = points.map((p) => p.raw);
    pca = new PCA(raw, { center: true });
    const projected = pca.predict(raw, { nComponents: n }).to2DArray();
    for (let i = 0; i < points.length; i++) {
      const target = projected[i];
      if (animate && points[i].proj) {
        points[i].from = points[i].proj;
        points[i].to = target;
      } else {
        points[i].from = target;
        points[i].to = target;
        points[i].proj = target;
      }
    }
    if (animate) {
      transitionStart = performance.now();
      transitioning = true;
    }
  }

  function addSample(raw: number[]) {
    for (const p of points) p.age++;
    // Between refits, project the new point with the already-fitted model — it just
    // fades in via the age->opacity mapping, no position tween needed.
    const proj = pca ? pca.predict([raw], { nComponents: nComponents() }).to2DArray()[0] : null;
    points.push({ raw, proj, from: proj, to: proj, age: 0 });
    if (points.length > BUFFER_SIZE) points.shift();

    samplesSinceRefit++;
    if (samplesSinceRefit >= PCA_REFIT_EVERY) {
      samplesSinceRefit = 0;
      refit(true);
    }
  }

  function updateAnimation(now: number) {
    if (!transitioning) return;
    const t = Math.min((now - transitionStart) / TRANSITION_MS, 1);
    const e = easeOutCubic(t);
    for (const p of points) {
      if (!p.from || !p.to) continue;
      p.proj = p.from.map((v, i) => v + (p.to![i] - v) * e);
    }
    if (t >= 1) {
      transitioning = false;
      for (const p of points) if (p.to) p.proj = p.to;
    }
  }

  function drawModeIcon(ctx: CanvasRenderingContext2D, dpr: number) {
    const s = 16 * dpr;
    const margin = 12 * dpr;
    const x = margin;
    const y = margin;
    drawIcon(ctx, mode === "cube" ? ICON_CUBE : ICON_PLANE, x, y, s, "#a5a294");
    iconBox = { x: (x - 4 * dpr) / dpr, y: (y - 4 * dpr) / dpr, w: (s + 8 * dpr) / dpr, h: (s + 8 * dpr) / dpr };
  }

  function renderPlane(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) {
    const pts = points.filter((p): p is Point & { proj: number[] } => !!p.proj);
    if (!pts.length) return;
    let maxAbs = 1e-6;
    for (const p of pts) for (const v of p.proj) if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    const pad = 24 * dpr;
    const scale = (Math.min(w, h) / 2 - pad) / maxAbs;
    const cx = w / 2, cy = h / 2;
    const screen: Vec2[] = pts.map((p) => [cx + p.proj[0] * scale, cy - p.proj[1] * scale]);

    const hull = convexHull2D(screen);
    if (hull.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
      ctx.closePath();
      ctx.fillStyle = rgba(ACCENT, 0.12);
      ctx.fill();
      ctx.strokeStyle = rgba(ACCENT, 0.35);
      ctx.lineWidth = dpr;
      ctx.stroke();
    }

    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(screen[i][0], screen[i][1], 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = rgba(ACCENT, opacityForAge(pts[i].age));
      ctx.fill();
    }

    const len = AXIS_LEN * dpr;
    ctx.strokeStyle = "#a5a294";
    ctx.lineWidth = dpr;
    for (const { label, dir } of AXES_2D) {
      const x = cx + dir[0] * len, y = cy - dir[1] * len;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      drawAxisLabel(ctx, x, y, label, dpr, false);
    }
  }

  function renderCube(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) {
    const pts = points.filter((p): p is Point & { proj: number[] } => !!p.proj && p.proj.length === 3);
    if (!pts.length) return;
    const rotated = pts.map((p) => rotate3(p.proj as Vec3, rotYaw, rotPitch));
    let maxAbs = 1e-6;
    for (const r of rotated) for (const v of r) if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    const pad = 24 * dpr;
    const scale = (Math.min(w, h) / 2 - pad) / maxAbs;
    const cx = w / 2, cy = h / 2;
    const screen = rotated.map(([x, y, z]) => ({ x: cx + x * scale, y: cy - y * scale, z }));

    // Hull, points, and axes all compete for depth — paint from one merged z-sorted list
    // so e.g. a nearer point correctly occludes a farther axis label, and vice versa.
    const items: Array<{ z: number; paint: () => void }> = [];

    const faces = convexHull3D(rotated);
    for (const f of faces) {
      const [a, b, c] = [screen[f[0]], screen[f[1]], screen[f[2]]];
      const z = (a.z + b.z + c.z) / 3;
      const fog = 1 - DEPTH_FOG_AMOUNT * (1 - depthT(z, maxAbs));
      items.push({
        z,
        paint: () => {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(c.x, c.y);
          ctx.closePath();
          ctx.fillStyle = rgba(ACCENT, 0.08 * fog);
          ctx.fill();
          ctx.strokeStyle = rgba(ACCENT, 0.15 * fog);
          ctx.stroke();
        },
      });
    }

    for (let i = 0; i < screen.length; i++) {
      const s = screen[i];
      const t = depthT(s.z, maxAbs);
      const radius = (1 + DEPTH_SIZE_AMOUNT * (2 * t - 1)) * 3 * dpr;
      const fog = 1 - DEPTH_FOG_AMOUNT * (1 - t);
      items.push({
        z: s.z,
        paint: () => {
          ctx.beginPath();
          ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = rgba(ACCENT, opacityForAge(pts[i].age) * fog);
          ctx.fill();
        },
      });
    }

    const len = AXIS_LEN * dpr;
    for (const { label, dir } of AXES_3D) {
      const r = rotate3(dir, rotYaw, rotPitch);
      const x = cx + r[0] * len, y = cy - r[1] * len;
      items.push({
        z: r[2],
        paint: () => {
          ctx.strokeStyle = "#a5a294";
          ctx.lineWidth = dpr;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(x, y);
          ctx.stroke();
          drawAxisLabel(ctx, x, y, label, dpr, true);
        },
      });
    }

    items.sort((a, b) => a.z - b.z); // back to front
    for (const item of items) item.paint();
  }

  function draw(M: MudrakaModule | null, specPtr: number, stream: Stream | null, ch: number) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);

    const now = performance.now();
    if (!lastSampleT) lastSampleT = now;
    if (M && stream && now - lastSampleT >= SAMPLE_INTERVAL_S * 1000) {
      lastSampleT = now;
      const res = stream.spectrumInto(specPtr);
      if (res.bins >= 2) {
        const f32 = new Float32Array(M.HEAPU8.buffer, specPtr, ch * res.bins);
        addSample(extractFeature(f32, ch, res.bins, res.bin_hz));
      }
    }
    updateAnimation(now);

    if (mode === "cube") renderCube(ctx, w, h, dpr);
    else renderPlane(ctx, w, h, dpr);
    drawModeIcon(ctx, dpr);
  }

  function setMode(newMode: Mode) {
    if (newMode === mode) return;
    mode = newMode;
    refit(false);
  }

  function toggleMode() {
    setMode(mode === "cube" ? "plane" : "cube");
  }

  function reset() {
    points.length = 0;
    pca = null;
    transitioning = false;
    samplesSinceRefit = 0;
    lastSampleT = 0;
  }

  return {
    draw,
    reset,
    toggleMode,
    hitTest(x: number, y: number) {
      return x >= iconBox.x && x <= iconBox.x + iconBox.w && y >= iconBox.y && y <= iconBox.y + iconBox.h;
    },
    get iconBox() {
      return iconBox;
    },
    get mode() {
      return mode;
    },
  };
}
