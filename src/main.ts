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
const COLORS = ["#58a6ff", "#3fb950", "#f778ba"];

// --- DOM ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connectBtn = $<HTMLButtonElement>("connect");
const statusEl = $("status");
const rateEl = $("rate");
const bannerEl = $("banner");
const plotsEl = $("plots");

const setStatus = (s: string) => (statusEl.textContent = s);

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
const peaks = new Float32Array(CH).fill(1);
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

    // auto-scale: track decaying peak so bursts stay on-screen, quiet doesn't flatline
    const ring = rings[c];
    let maxAbs = 0;
    for (let i = 0; i < WINDOW; i++) {
      const a = Math.abs(ring[i]);
      if (a > maxAbs) maxAbs = a;
    }
    peaks[c] = Math.max(maxAbs, peaks[c] * 0.95);
    const half = (peaks[c] * 1.1) || 1;

    // zero line
    ctx.strokeStyle = "#21262d";
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

function onNotification(e: Event) {
  const dv = (e.target as BluetoothRemoteGATTCharacteristic).value!;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  stream!.feed(bytes, performance.now() / 1000);
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

let rateTimer = 0;
function startRateReadout() {
  rateTimer = window.setInterval(() => {
    if (stream) rateEl.textContent = `${stream.estimatedRateHz().toFixed(0)} Hz`;
  }, 500);
}

function cleanup() {
  clearInterval(rateTimer);
  rateEl.textContent = "";
  if (stream) { stream.delete(); stream = null; }
  if (M && dstPtr) { M._free(dstPtr); dstPtr = 0; }
  cursor = 0;
  writeIdx = 0;
  rings.forEach((r) => r.fill(0));
  peaks.fill(1);
  connectBtn.textContent = "Connect";
  connectBtn.classList.remove("connected");
  connectBtn.disabled = false;
}

function onDisconnected() {
  setStatus("Device disconnected");
  cleanup();
}

async function connect() {
  connectBtn.disabled = true;
  setStatus("Select a device…");
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Mudra" }, { namePrefix: "mudra" }],
      optionalServices: [SERVICE],
    });
  } catch {
    setStatus("Connection cancelled");
    connectBtn.disabled = false;
    return;
  }

  try {
    setStatus("Connecting…");
    device.addEventListener("gattserverdisconnected", onDisconnected);
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(uuid(SERVICE));
    const snc = await service.getCharacteristic(uuid(CHAR_SNC));
    const cmd = await service.getCharacteristic(uuid(CHAR_CMD));

    if (!M) M = await createMudraka({ locateFile: () => wasmUrl });
    stream = new M.Stream(M.makeConfig(CH, RATE, 4));
    dstPtr = M._malloc(CH * MAX_PULL * 4);
    cursor = 0;

    snc.addEventListener("characteristicvaluechanged", onNotification);
    await snc.startNotifications();
    await cmd.writeValue(ENABLE_SNC); // streams are off by default

    setStatus("Streaming");
    startRateReadout();
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.add("connected");
    connectBtn.disabled = false;
  } catch (err) {
    setStatus(`Connection failed: ${(err as Error).message}`);
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
