import createMudraka, { type MudrakaModule, type Stream } from "mudraka";
import wasmUrl from "mudraka/mudraka.wasm?url";

// --- Mudra Link BLE constants (see mudraka docs/MUDRA_LINK_SIGNAL_SPEC.md) ---
const SERVICE = 0xfff0; // parent service (assumed; confirm on real device)
const CHAR_SNC = 0x0000fff4; // raw sEMG notifications
const CHAR_CMD = 0x0000fff1; // COMMAND (host writes enable here)
const ENABLE_SNC = Uint8Array.of(0x06, 0x00, 0x01); // start SNC stream
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
  feedBytes(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), performance.now() / 1000);
}

function cleanup() {
  if (stream) { stream.delete(); stream = null; }
  if (M && dstPtr) { M._free(dstPtr); dstPtr = 0; }
  cursor = 0;
  writeIdx = 0;
  rings.forEach((r) => r.fill(0));
  connectBtn.textContent = "Connect";
  connectBtn.classList.remove("connected");
  connectBtn.disabled = false;
  playBtn.textContent = "Play sample";
  playBtn.classList.remove("connected");
  playBtn.disabled = false;
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
    const snc = await service.getCharacteristic(uuid(CHAR_SNC));
    const cmd = await service.getCharacteristic(uuid(CHAR_CMD));

    await setupEngine();

    snc.addEventListener("characteristicvaluechanged", onNotification);
    await snc.startNotifications();
    await cmd.writeValue(ENABLE_SNC); // streams are off by default

    setStatus("Streaming", "ok");
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.add("connected");
    connectBtn.disabled = false;
  } catch (err) {
    setStatus(`Connection failed: ${(err as Error).message}`, "error");
    device?.gatt?.disconnect();
    cleanup();
  }
}

function disconnect() {
  device?.gatt?.disconnect(); // fires gattserverdisconnected -> cleanup
}

connectBtn.addEventListener("click", () =>
  connectBtn.classList.contains("connected") ? disconnect() : connect(),
);

// --- Recorded-session playback (no device needed) ---
// Replays a captured session's raw SNC frames through the same decode path as the
// live BLE feed, at the frames' recorded cadence. Loops until stopped.
const SAMPLE = "16bit_rest";
let playing = false;
let playRaf = 0;

type Frame = { offset: number; len: number; uuid: string; dir: string; t_mono_ns: number };

async function play() {
  playBtn.disabled = true;
  connectBtn.disabled = true;
  setStatus("Loading sample…", "busy");

  let bin: Uint8Array;
  let frames: Frame[];
  try {
    const dir = `${import.meta.env.BASE_URL}fixtures/${SAMPLE}`;
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
  playBtn.textContent = "Stop";
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

playBtn.addEventListener("click", () => (playing ? stopPlay() : play()));
