import createMudraka, { type MudrakaModule, type Stream } from "mudraka";
import wasmUrl from "mudraka/mudraka.wasm?url";

// --- Mudra Link BLE constants (see mudraka docs/MUDRA_LINK_SIGNAL_SPEC.md) ---
const SERVICE = 0xfff0; // parent service (assumed; confirm on real device)
const CHAR_SNC = 0x0000fff4; // raw sEMG notifications
const CHAR_CMD = 0x0000fff1; // COMMAND (host writes enable here)
const ENABLE_SNC = Uint8Array.of(0x06, 0x00, 0x01); // start SNC stream
const DISABLE_SNC = Uint8Array.of(0x06, 0x00, 0x00); // stop SNC stream (return device to idle)
const uuid = (n: number) =>
  `0000${(n & 0xffff).toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;

const CH = 3;
const RATE = 834;
const LABELS = ["ulnar", "median", "radial"];
const WINDOW = Math.ceil(3 * RATE); // ~3 s of samples per channel
const COLORS = ["#2563eb", "#0f9d58", "#c026d3"];
// Mudra Link SNC is fixed 16-bit signed (docs); pin the amplitude to the full range.
const AMP_HALF = 32768 * 1.1;

// --- DOM ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connectBtn = $<HTMLButtonElement>("connect");
const playBtn = $<HTMLButtonElement>("play");
const recordBtn = $<HTMLButtonElement>("record");
const playMenu = $("play-menu");

// Fixtures under public/fixtures/ are detected at build time — drop a new
// recording folder (with capture.bin + index.json) and it shows up in the dropdown.
const FIXTURES = Object.keys(import.meta.glob("/public/fixtures/*/index.json"))
  .map((p) => p.split("/")[3])
  .sort();

playMenu.innerHTML = FIXTURES.length
  ? FIXTURES.map((f) => `<button data-fixture="${f}">${f.replace(/_/g, " ")}</button>`).join("")
  : "<button disabled>No samples</button>";
const statusEl = $("status");
const bannerEl = $("banner");
const plotsEl = $("plots");

// Status is a color-coded dot; the message lives in the tooltip (hover to read).
type StatusKind = "idle" | "busy" | "ok" | "error";
const setStatus = (text: string, kind: StatusKind = "idle") => {
  statusEl.className = kind === "idle" ? "" : kind;
  statusEl.title = text;
};

// --- Compatibility gate ---
if (!navigator.bluetooth) {
  bannerEl.style.display = "block";
  bannerEl.textContent =
    "This browser does not support Web Bluetooth. Please open in Chrome or Edge (desktop / Android). iOS is not supported.";
  connectBtn.disabled = true;
}

// --- Display ring buffers (one Float32Array per channel, shared write cursor) ---
const rings = Array.from({ length: CH }, () => new Float32Array(WINDOW));
let writeIdx = 0; // next write position; total count is unbounded but we only keep WINDOW
const canvases: HTMLCanvasElement[] = [];
for (let c = 0; c < CH; c++) {
  const lane = document.createElement("div");
  lane.className = "lane";
  const label = document.createElement("label");
  label.textContent = LABELS[c];
  label.style.color = COLORS[c];
  const canvas = document.createElement("canvas");
  lane.append(label, canvas);
  plotsEl.append(lane);
  canvases.push(canvas);
}

function pushSample(values: number[]) {
  for (let c = 0; c < CH; c++) rings[c][writeIdx] = values[c];
  writeIdx = (writeIdx + 1) % WINDOW;
}

// --- Rendering (rAF, decoupled from BLE feed) ---
function draw() {
  for (let c = 0; c < CH; c++) {
    const canvas = canvases[c];
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);

    const ring = rings[c];
    const half = AMP_HALF; // fixed full-scale, no auto-adjust

    // zero line
    ctx.strokeStyle = "#e0ddd0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // waveform: oldest sample at left, newest at right
    ctx.strokeStyle = COLORS[c];
    ctx.lineWidth = dpr;
    ctx.beginPath();
    for (let k = 0; k < WINDOW; k++) {
      const v = ring[(writeIdx + k) % WINDOW];
      const x = (k / (WINDOW - 1)) * w;
      const y = h / 2 - (v / half) * (h / 2);
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// --- WASM engine + BLE connection ---
let M: MudrakaModule | null = null;
let stream: Stream | null = null;
let dstPtr = 0;
let cursor = 0;
let device: BluetoothDevice | null = null;
let sncChar: BluetoothRemoteGATTCharacteristic | null = null;
let cmdChar: BluetoothRemoteGATTCharacteristic | null = null;

const MAX_PULL = 256;

// Shared decode path: raw SNC frame bytes in, decoded samples pushed to display.
// Both the live BLE feed and the recorded-session playback go through here.
function feedBytes(bytes: Uint8Array, tSec: number) {
  stream!.feed(bytes, tSec);
  const base = dstPtr >> 2;
  for (;;) {
    const r = stream!.pullInto(cursor, dstPtr, MAX_PULL);
    for (let i = 0; i < r.written; i++) {
      pushSample([
        M!.HEAP32[base + 0 * MAX_PULL + i],
        M!.HEAP32[base + 1 * MAX_PULL + i],
        M!.HEAP32[base + 2 * MAX_PULL + i],
      ]);
    }
    cursor = r.next_cursor;
    if (r.written < MAX_PULL) break;
  }
}

async function setupEngine() {
  if (!M) M = await createMudraka({ locateFile: () => wasmUrl });
  stream = new M.Stream(M.makeConfig(CH, RATE, 4));
  dstPtr = M._malloc(CH * MAX_PULL * 4);
  cursor = 0;
}

function onNotification(e: Event) {
  const dv = (e.target as BluetoothRemoteGATTCharacteristic).value!;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (recording) recordFrame(bytes);
  feedBytes(bytes, performance.now() / 1000);
}

function cleanup() {
  sncChar?.removeEventListener("characteristicvaluechanged", onNotification);
  sncChar = null;
  cmdChar = null;
  if (stream) { stream.delete(); stream = null; }
  if (M && dstPtr) { M._free(dstPtr); dstPtr = 0; }
  cursor = 0;
  writeIdx = 0;
  rings.forEach((r) => r.fill(0));
  connectBtn.textContent = "Connect";
  connectBtn.classList.remove("connected");
  connectBtn.disabled = false;
  playBtn.textContent = "Play ▾";
  playBtn.classList.remove("connected");
  playBtn.disabled = false;
  recording = false;
  recordBtn.textContent = "● Record";
  recordBtn.classList.remove("connected");
  recordBtn.disabled = true; // re-enabled only once a live stream is up
}

function onDisconnected() {
  setStatus("Device disconnected", "idle");
  cleanup();
}

async function connect() {
  connectBtn.disabled = true;
  playBtn.disabled = true;
  setStatus("Select a device…", "busy");
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Mudra" }, { namePrefix: "mudra" }],
      optionalServices: [SERVICE],
    });
  } catch {
    setStatus("Connection cancelled", "idle");
    connectBtn.disabled = false;
    playBtn.disabled = false;
    return;
  }

  try {
    setStatus("Connecting…", "busy");
    device.addEventListener("gattserverdisconnected", onDisconnected);
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(uuid(SERVICE));
    sncChar = await service.getCharacteristic(uuid(CHAR_SNC));
    cmdChar = await service.getCharacteristic(uuid(CHAR_CMD));

    await setupEngine();

    sncChar.addEventListener("characteristicvaluechanged", onNotification);
    await sncChar.startNotifications();
    await cmdChar.writeValue(ENABLE_SNC); // streams are off by default

    setStatus("Streaming", "ok");
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.add("connected");
    connectBtn.disabled = false;
    recordBtn.disabled = false;
  } catch (err) {
    setStatus(`Connection failed: ${(err as Error).message}`, "error");
    device?.gatt?.disconnect();
    cleanup();
  }
}

async function disconnect() {
  connectBtn.disabled = true;
  // Return the device to idle before dropping GATT. Skipping this leaves the
  // firmware streaming, and macOS/CoreBluetooth then refuses the next connect
  // until the user "Forget This Device". Best-effort: the link may already be gone.
  try {
    await cmdChar?.writeValue(DISABLE_SNC);
    await sncChar?.stopNotifications();
  } catch { /* device already disconnected */ }
  device?.gatt?.disconnect(); // fires gattserverdisconnected -> cleanup
}

connectBtn.addEventListener("click", () =>
  connectBtn.classList.contains("connected") ? disconnect() : connect(),
);

// --- Recorded-session playback (no device needed) ---
// Replays a captured session's raw SNC frames through the same decode path as the
// live BLE feed, at the frames' recorded cadence. Loops until stopped.
let playing = false;
let playRaf = 0;

type Frame = { offset: number; len: number; uuid: string; dir: string; t_mono_ns: number };

async function play(name: string) {
  playBtn.disabled = true;
  connectBtn.disabled = true;
  setStatus("Loading sample…", "busy");

  let bin: Uint8Array;
  let frames: Frame[];
  try {
    const dir = `${import.meta.env.BASE_URL}fixtures/${name}`;
    const [buf, index] = await Promise.all([
      fetch(`${dir}/capture.bin`).then((r) => r.arrayBuffer()),
      fetch(`${dir}/index.json`).then((r) => r.json()),
    ]);
    bin = new Uint8Array(buf);
    const sncUuid = uuid(CHAR_SNC);
    frames = (index.frames as Frame[]).filter((f) => f.uuid === sncUuid && f.dir === "rx");
  } catch (err) {
    setStatus(`Failed to load sample: ${(err as Error).message}`, "error");
    connectBtn.disabled = false;
    playBtn.disabled = false;
    return;
  }

  await setupEngine();
  playing = true;
  playBtn.textContent = "■ Stop";
  playBtn.classList.add("connected");
  playBtn.disabled = false;
  setStatus("Playing sample", "ok");

  // ponytail: looping re-feeds from frame 0, so ~one glitch per 34 s loop as the
  // decoder's SNC sequence jumps back. Fine for a demo; rebuild the stream per loop if it matters.
  const runOnce = () => {
    const t0 = frames[0].t_mono_ns;
    const start = performance.now();
    let i = 0;
    const tick = () => {
      if (!playing) return;
      const elapsed = performance.now() - start;
      while (i < frames.length && (frames[i].t_mono_ns - t0) / 1e6 <= elapsed) {
        const f = frames[i++];
        feedBytes(bin.subarray(f.offset, f.offset + f.len), performance.now() / 1000);
      }
      playRaf = requestAnimationFrame(i < frames.length ? tick : runOnce);
    };
    playRaf = requestAnimationFrame(tick);
  };
  runOnce();
}

function stopPlay() {
  playing = false;
  cancelAnimationFrame(playRaf);
  setStatus("Not connected", "idle");
  cleanup();
}

// Playing → button stops. Idle → button toggles the fixture menu.
playBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (playing) { stopPlay(); return; }
  playMenu.hidden = !playMenu.hidden;
});
playMenu.addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).dataset.fixture;
  if (f) { playMenu.hidden = true; play(f); }
});
// Click anywhere else closes the menu.
document.addEventListener("click", () => (playMenu.hidden = true));

// --- Guided recording (device must be streaming) ---
// Scripts the user through a fixed gesture protocol while stashing a copy of every
// live SNC frame, then downloads capture.bin + index.json in the same shape the
// playback loader above consumes. Pure client-side download — works identically on
// GitHub Pages and localhost. Drop both files into public/fixtures/<name>/ to add a sample.
const PROTOCOL = [
  { label: "Grasp", reps: 3 },
  { label: "Open", reps: 3 },
  { label: "Pinch", reps: 3 },
  { label: "Pronation", reps: 3 }, // 回内
  { label: "Supination", reps: 3 }, // 回外
];
const STEP_SEC = 5;

let recording = false;
let recStart = 0;
let recOffset = 0;
const recChunks: Uint8Array[] = [];
const recFrames: Frame[] = [];
const recMarkers: { label: string; reps: number; t_mono_ns: number }[] = [];
const nowNs = () => Math.round((performance.now() - recStart) * 1e6);

function recordFrame(bytes: Uint8Array) {
  const copy = bytes.slice(); // BLE reuses the DataView buffer — must copy before it changes
  recFrames.push({ offset: recOffset, len: copy.length, uuid: uuid(CHAR_SNC), dir: "rx", t_mono_ns: nowNs() });
  recChunks.push(copy);
  recOffset += copy.length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function record() {
  recChunks.length = recFrames.length = recMarkers.length = 0;
  recOffset = 0;
  recStart = performance.now();
  recording = true;
  recordBtn.textContent = "■ Stop";
  recordBtn.classList.add("connected");
  connectBtn.disabled = playBtn.disabled = true;

  for (const step of PROTOCOL) {
    if (!recording) break;
    recMarkers.push({ label: step.label, reps: step.reps, t_mono_ns: nowNs() });
    for (let s = STEP_SEC; s > 0 && recording; s--) {
      bannerEl.style.display = "block";
      bannerEl.textContent = `Recording — ${step.label} × ${step.reps}   ·   ${s}s`;
      await sleep(1000);
    }
  }

  const completed = recording; // false if the user hit Stop early → discard
  recording = false;
  bannerEl.style.display = "none";
  recordBtn.textContent = "● Record";
  recordBtn.classList.remove("connected");
  connectBtn.disabled = playBtn.disabled = false;

  if (completed && recFrames.length) downloadRecording();
  else setStatus("Streaming", "ok");
}

function downloadRecording() {
  const bin = new Uint8Array(recOffset);
  let o = 0;
  for (const c of recChunks) { bin.set(c, o); o += c.length; }
  const index = { frames: recFrames.map((f, i) => ({ i, ...f })), markers: recMarkers };
  save(new Blob([bin]), "capture.bin");
  save(new Blob([JSON.stringify(index)], { type: "application/json" }), "index.json");
  setStatus("Saved capture.bin + index.json → drop into public/fixtures/<name>/", "ok");
}

function save(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Recording → Stop (discards). Idle → start the guided protocol.
recordBtn.addEventListener("click", () => (recording ? (recording = false) : record()));
