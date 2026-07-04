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
  statusEl.dataset.tip = text;
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
// Decoded samples land here; the free-running display clock (see advanceRing) drains
// them at RATE. Whatever source is active (live BLE / recorded playback) just fills it.
const sampleQueue: number[][] = [];
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

// Free-running display clock: advance the ring at RATE, draining queued samples
// and writing zeros when the queue is empty. So the trace always scrolls — idle
// shows a flat line, a finished recording scrolls out instead of snapping to zero.
let lastAdvance = 0;
function advanceRing(now: number) {
  if (!lastAdvance) lastAdvance = now;
  let n = Math.floor(((now - lastAdvance) / 1000) * RATE);
  if (n > WINDOW) n = WINDOW; // don't over-catch-up after a tab pause
  for (let k = 0; k < n; k++) {
    const s = sampleQueue.shift();
    for (let c = 0; c < CH; c++) rings[c][writeIdx] = s ? s[c] : 0;
    writeIdx = (writeIdx + 1) % WINDOW;
  }
  lastAdvance += (n / RATE) * 1000; // carry the sub-sample remainder
}

// --- Rendering (rAF, decoupled from BLE feed) ---
function draw() {
  advanceRing(performance.now());
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
      sampleQueue.push([
        M!.HEAP32[base + 0 * MAX_PULL + i],
        M!.HEAP32[base + 1 * MAX_PULL + i],
        M!.HEAP32[base + 2 * MAX_PULL + i],
      ]);
    }
    cursor = r.next_cursor;
    if (r.written < MAX_PULL) break;
  }
  // Bound latency: a burst can't back up more than one screen behind the clock.
  if (sampleQueue.length > WINDOW) sampleQueue.splice(0, sampleQueue.length - WINDOW);
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
  sampleQueue.length = 0; // stop feeding; the clock scrolls zeros in on its own
  connectBtn.textContent = "Connect";
  connectBtn.classList.remove("connected");
  connectBtn.disabled = false;
  playBtn.textContent = "Play ▾";
  playBtn.classList.remove("connected");
  playBtn.disabled = false;
  recording = false;
  clearInterval(recTimer);
  if (bannerEl.textContent?.startsWith("●")) bannerEl.style.display = "none";
  recordBtn.textContent = "Record";
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
  try {
    // Reuse a retained device on reconnect instead of the chooser, which fails on
    // macOS for this bonded, address-rotating band (docs/adr/0001).
    if (!device) {
      // getDevices() returns the already-granted device without scanning, so we can
      // reconnect after a reload while macOS still holds the (non-advertising) link.
      // Needs Chrome flags; falls back to the chooser. Match by stable id (name can
      // be null for an OS-held device).
      const granted = (await navigator.bluetooth.getDevices?.()) ?? [];
      const savedId = localStorage.getItem("mudra-device-id");
      const known =
        granted.find((d) => d.id === savedId) ??
        granted.find((d) => /^mudra/i.test(d.name ?? ""));
      if (known) {
        device = known;
      } else {
        setStatus("Select a device…", "busy");
        device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: "Mudra" }, { namePrefix: "mudra" }],
          optionalServices: [SERVICE],
        });
      }
      localStorage.setItem("mudra-device-id", device.id);
      device.addEventListener("gattserverdisconnected", onDisconnected);
    }
  } catch {
    setStatus("Connection cancelled", "error");
    connectBtn.disabled = false;
    playBtn.disabled = false;
    return;
  }

  try {
    setStatus("Connecting…", "busy");
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
    device = null; // drop the stale ref so the next Connect re-picks via the chooser
    cleanup();
  }
}

async function disconnect() {
  connectBtn.disabled = true;
  // Stop the stream before dropping GATT; leaving it streaming makes macOS refuse
  // the next connect until "Forget This Device". Best-effort — link may be gone.
  try {
    await cmdChar?.writeValue(DISABLE_SNC);
    await sncChar?.stopNotifications();
  } catch { /* device already disconnected */ }
  device?.gatt?.disconnect(); // fires gattserverdisconnected -> cleanup
}

connectBtn.addEventListener("click", () =>
  connectBtn.classList.contains("connected") ? disconnect() : connect(),
);

// Tab close / reload: best-effort graceful stop before we go. The async write may
// not flush, but gatt.disconnect() drops the link. pagehide also covers bfcache nav.
window.addEventListener("pagehide", () => {
  if (!device?.gatt?.connected) return;
  cmdChar?.writeValue(DISABLE_SNC).catch(() => {});
  device.gatt.disconnect();
});

// HMR reloads leave the BLE link up; unlike pagehide, dispose() can await a full stop.
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    if (!device?.gatt?.connected) return;
    try {
      await cmdChar?.writeValue(DISABLE_SNC);
      await sncChar?.stopNotifications();
    } catch { /* link may already be gone */ }
    device.gatt.disconnect();
  });
}

// --- Recorded-session playback (no device needed) ---
// Replays a captured session's raw SNC frames through the same decode path as the
// live BLE feed, at the frames' recorded cadence. Plays through once, then stops.
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
    if (i < frames.length) playRaf = requestAnimationFrame(tick);
    else { // played through once — stop feeding; the clock scrolls the tail out
      playing = false;
      cleanup();
      setStatus("Sample finished", "idle");
    }
  };
  playRaf = requestAnimationFrame(tick);
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

// --- Recording (device must be streaming) ---
// Free-form: Record starts stashing a copy of every live SNC frame, Stop ends it and
// downloads capture.bin + index.json in the same shape the playback loader above reads.
// Pure client-side download — identical on GitHub Pages and localhost. Drop both files
// into public/fixtures/<your-name>/ (you name the folder) and rebuild to add a sample.
let recording = false;
let recStart = 0;
let recOffset = 0;
let recTimer = 0;
const recChunks: Uint8Array[] = [];
const recFrames: Frame[] = [];

function recordFrame(bytes: Uint8Array) {
  const copy = bytes.slice(); // BLE reuses the DataView buffer — must copy before it changes
  const t_mono_ns = Math.round((performance.now() - recStart) * 1e6);
  recFrames.push({ offset: recOffset, len: copy.length, uuid: uuid(CHAR_SNC), dir: "rx", t_mono_ns });
  recChunks.push(copy);
  recOffset += copy.length;
}

function startRecording() {
  recChunks.length = recFrames.length = 0;
  recOffset = 0;
  recStart = performance.now();
  recording = true;
  recordBtn.textContent = "Stop";
  recordBtn.classList.add("connected");
  connectBtn.disabled = playBtn.disabled = true;
  recTimer = window.setInterval(() => {
    bannerEl.style.display = "block";
    bannerEl.textContent = `● Recording… ${Math.floor((performance.now() - recStart) / 1000)}s`;
  }, 250);
}

function stopRecording() {
  recording = false;
  clearInterval(recTimer);
  bannerEl.style.display = "none";
  recordBtn.textContent = "Record";
  recordBtn.classList.remove("connected");
  connectBtn.disabled = playBtn.disabled = false;
  if (recFrames.length) downloadRecording();
  else setStatus("Streaming", "ok");
}

function downloadRecording() {
  const bin = new Uint8Array(recOffset);
  let o = 0;
  for (const c of recChunks) { bin.set(c, o); o += c.length; }
  const index = enc.encode(JSON.stringify({ frames: recFrames.map((f, i) => ({ i, ...f })) }));
  // Fixed name: you rename record/ to your gesture name when dropping it into public/fixtures/.
  const archive = zip([
    { name: "record/capture.bin", data: bin },
    { name: "record/index.json", data: index },
  ]);
  save(new Blob([archive], { type: "application/zip" }), "record.zip");
  setStatus("Saved record.zip → unzip into public/fixtures/ and rename the folder", "ok");
}

// --- Minimal store-only (uncompressed) ZIP writer — no dependency ---
const enc = new TextEncoder();
const u16 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
const u32 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files: { name: string; data: Uint8Array }[]) {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nb = enc.encode(f.name);
    const crc = crc32(f.data);
    const sz = f.data.length;
    const header = concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(sz), u32(sz), u16(nb.length), u16(0), nb]);
    local.push(header, f.data);
    central.push(concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(sz), u32(sz), u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nb]));
    offset += header.length + sz;
  }
  const cd = concat(central);
  const end = concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0)]);
  return concat([...local, cd, end]);
}
// self-check: CRC-32 of "123456789" is the standard 0xCBF43926 test vector
if (import.meta.env.DEV && crc32(enc.encode("123456789")) !== 0xcbf43926) throw new Error("crc32 broken");

function save(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

recordBtn.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
