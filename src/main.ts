import createMudraka, { type MudrakaModule, type Stream } from "mudraka";
import wasmUrl from "mudraka/mudraka.wasm?url";
import { drawTime } from "./views/time";
import { createSpectrumView, SPEC_WINDOW, SPEC_BINS } from "./views/spectrum";
import { createManifoldView } from "./views/manifold";
import { createSpikesView } from "./views/spikes";
import { zip } from "./zip";

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

// --- DOM ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connectBtn = $<HTMLButtonElement>("connect");
const playBtn = $<HTMLButtonElement>("play");
const recordBtn = $<HTMLButtonElement>("record");

// Icons: inline SVG (lucide paths), same no-dependency policy as the rest of the UI. Label text
// is hidden on narrow (mobile) viewports via CSS, leaving just the icon — see index.html's media query.
const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
const ICON_SQUARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;
const ICON_CIRCLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;
const ICON_CIRCLE_REC = `<svg viewBox="0 0 24 24" fill="#d92d20" stroke="#d92d20" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`;
const ICON_BLUETOOTH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>`;
const ICON_BLUETOOTH_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 17-5 5V12l-5 5"/><path d="M2 2l20 20"/><path d="M14.5 9.5 17 7l-5-5v4.5"/></svg>`;

function setBtn(btn: HTMLButtonElement, icon: string, label: string) {
  btn.innerHTML = `${icon}<span class="label">${label}</span>`;
  btn.setAttribute("aria-label", label.replace(/\s*▾$/, ""));
}

setBtn(connectBtn, ICON_BLUETOOTH, "Connect");
setBtn(playBtn, ICON_PLAY, "Play ▾");
setBtn(recordBtn, ICON_CIRCLE, "Record");
const playMenu = $("play-menu");
const tabTime = $<HTMLButtonElement>("tab-time");
const tabFreq = $<HTMLButtonElement>("tab-freq");
const tabManifold = $<HTMLButtonElement>("tab-manifold");
const tabSpikes = $<HTMLButtonElement>("tab-spikes");
const tabsIndicator = $("tabs-indicator");
const spectrumEl = $("spectrum");
const specCanvas = $<HTMLCanvasElement>("spec");
const specLegend = $("spec-legend");
const specTip = $("spec-tip");
const manifoldEl = $("manifold");
const manifoldCanvas = $<HTMLCanvasElement>("manifold-canvas");
const manifoldTip = $("manifold-tip");
const spikesEl = $("spikes");
const spikesCanvas = $<HTMLCanvasElement>("spikes-canvas");
const spikesInfoBtn = $<HTMLButtonElement>("spikes-info");
const spikesDialog = $<HTMLDialogElement>("spikes-dialog");
const spikesDialogClose = $<HTMLButtonElement>("spikes-dialog-close");
// ponytail: manifold info dialog disabled, HTML commented out in index.html
// const manifoldInfoBtn = $<HTMLButtonElement>("manifold-info");
// const manifoldDialog = $<HTMLDialogElement>("manifold-dialog");
// const manifoldDialogClose = $<HTMLButtonElement>("manifold-dialog-close");

// Fixtures under public/fixtures/ are detected at build time — drop a new recording folder (with capture.bin + index.json) and it shows up in the dropdown.
const FIXTURES = Object.keys(import.meta.glob("/public/fixtures/*/index.json"))
  .map((p) => p.split("/")[3])
  .sort();

// Folder name is shown as-is (e.g. "grasp", "grasp (strong)").
playMenu.innerHTML = FIXTURES.length
  ? FIXTURES.map((f) => `<button data-fixture="${f}">${f}</button>`).join("")
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
  const closeBtn = document.createElement("button");
  closeBtn.className = "banner-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.textContent = "×";
  closeBtn.onclick = () => { bannerEl.style.display = "none"; };
  bannerEl.append(closeBtn);
  connectBtn.disabled = true;
}

// --- Display ring buffers (one Float32Array per channel, shared write cursor) ---
const rings = Array.from({ length: CH }, () => new Float32Array(WINDOW));
let writeIdx = 0; // next write position; total count is unbounded but we only keep WINDOW
// Decoded samples land here; the free-running display clock (see advanceRing) drains them at RATE — whatever source is active (live BLE / recorded playback) just fills it.
const sampleQueue: number[][] = [];
const ZEROS = new Array(CH).fill(0); // fed to the spike processor when the queue is empty (idle scroll)
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

// --- View toggle (Time / Frequency / Manifold), both off the same Stream ---
// Each tab is also a shareable route (/time, /freq, /manifold) with working back/forward; navigation stays client-side so switching views never drops the live BLE connection.
// GH Pages has no server-side SPA fallback, so the build copies index.html to 404.html (see package.json) to serve direct hits.
specLegend.innerHTML = LABELS.map(
  (l, i) => `<span style="color:${COLORS[i]}">${l}</span>`,
).join("");
type View = "time" | "freq" | "manifold" | "spikes";
const VIEWS: View[] = ["time", "freq", "manifold", "spikes"];
const pathForView = (v: View) => import.meta.env.BASE_URL + v;
const viewFromPath = (pathname: string): View => {
  const rel = pathname.slice(import.meta.env.BASE_URL.length).replace(/\/$/, "");
  return (VIEWS as string[]).includes(rel) ? (rel as View) : "time";
};

const spectrumView = createSpectrumView(specCanvas, COLORS);
const manifoldView = createManifoldView(manifoldCanvas);
const spikesView = createSpikesView(spikesCanvas);

function moveTabIndicator() {
  const active = document.querySelector<HTMLButtonElement>("#tabs button.active");
  if (!active) return;
  tabsIndicator.style.width = `${active.offsetWidth}px`;
  tabsIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
}
window.addEventListener("resize", moveTabIndicator); // desktop <-> mobile layout changes tab widths

let view: View = viewFromPath(location.pathname);
function setView(v: View) {
  view = v;
  tabTime.classList.toggle("active", v === "time");
  tabFreq.classList.toggle("active", v === "freq");
  tabManifold.classList.toggle("active", v === "manifold");
  tabSpikes.classList.toggle("active", v === "spikes");
  moveTabIndicator();
  plotsEl.hidden = v !== "time";
  spectrumEl.hidden = v !== "freq";
  manifoldEl.hidden = v !== "manifold";
  spikesEl.hidden = v !== "spikes";
  if (v === "manifold") manifoldView.reset(); // fresh point cloud each time the tab opens
  // fresh live state; learn W on first open. Defer the kickoff to a microtask so a direct landing
  // on /spikes (setView runs during module init) doesn't touch engine state (M) still in its TDZ.
  if (v === "spikes") { spikesView.reset(); queueMicrotask(ensureSpikes); }
}

// Learn the separation matrix W once, lazily, from all fixtures decoded through mudraka. Cached for
// the session (docs/adr/0003). Kicked off on first Spikes-tab open; the fetch await lets the
// "learning…" frame paint before the (blocking) fastICA runs.
let spikesLearning = false;
let spikesStatus = "";
async function ensureSpikes() {
  if (spikesView.ready || spikesLearning) return;
  spikesLearning = true;
  spikesStatus = "Learning motor unit sources…";
  try {
    const fixtures = await decodeFixtures();
    spikesView.learnW(fixtures);
    spikesStatus = spikesView.ready ? "" : "No sources separated — try a different recording";
  } catch (err) {
    spikesStatus = `Learn failed: ${(err as Error).message}`;
  } finally {
    spikesLearning = false;
  }
}
function navigate(v: View) {
  if (v !== view) history.pushState(null, "", pathForView(v));
  setView(v);
}
history.replaceState(null, "", pathForView(view)); // canonicalize "/" (or an unknown path) to "/time"
setView(view);
window.addEventListener("popstate", () => setView(viewFromPath(location.pathname)));
tabTime.addEventListener("click", () => navigate("time"));
tabFreq.addEventListener("click", () => navigate("freq"));
tabManifold.addEventListener("click", () => navigate("manifold"));
tabSpikes.addEventListener("click", () => navigate("spikes"));
spikesInfoBtn.addEventListener("click", () => spikesDialog.showModal());
spikesDialogClose.addEventListener("click", () => spikesDialog.close());

// Mode-toggle icon on the manifold canvas: click switches Plane <-> Cube, pointer on hover — same DOM-tooltip pattern as the spectrum lock icon (see specTip above).
const modeTip = () => (manifoldView.mode === "cube" ? "Click for Plane view" : "Click for Cube view");
const showManifoldTip = () => {
  const box = manifoldView.iconBox;
  manifoldTip.textContent = modeTip();
  manifoldTip.style.left = `${box.x}px`;
  manifoldTip.style.top = `${box.y + box.h + 2}px`;
  manifoldTip.style.display = "block";
};
manifoldCanvas.addEventListener("click", (e) => {
  if (manifoldView.hitTest(e.offsetX, e.offsetY)) { manifoldView.toggleMode(); showManifoldTip(); }
});
manifoldCanvas.addEventListener("mousemove", (e) => {
  const on = manifoldView.hitTest(e.offsetX, e.offsetY);
  manifoldCanvas.style.cursor = on ? "pointer" : manifoldView.mode === "cube" ? "grab" : "default";
  on ? showManifoldTip() : (manifoldTip.style.display = "none");
});
manifoldCanvas.addEventListener("mouseleave", () => (manifoldTip.style.display = "none"));

// manifoldInfoBtn.addEventListener("click", () => manifoldDialog.showModal());
// manifoldDialogClose.addEventListener("click", () => manifoldDialog.close());

// Lock icon on the spectrum canvas: click toggles freezing the axis top, pointer on hover — instant DOM tooltip (same style as the status dot), positioned under the lock icon.
const lockTip = () => (spectrumView.locked ? "Click to auto-scale" : "Click to lock");
const showTip = () => {
  const box = spectrumView.lockBox;
  specTip.textContent = lockTip();
  specTip.style.left = `${box.x}px`;
  specTip.style.top = `${box.y + box.h + 2}px`;
  specTip.style.display = "block";
};
specCanvas.addEventListener("click", (e) => {
  if (spectrumView.hitTest(e.offsetX, e.offsetY)) { spectrumView.toggleLock(); showTip(); }
});
specCanvas.addEventListener("mousemove", (e) => {
  const on = spectrumView.hitTest(e.offsetX, e.offsetY);
  specCanvas.style.cursor = on ? "pointer" : "default";
  on ? showTip() : (specTip.style.display = "none");
});
specCanvas.addEventListener("mouseleave", () => (specTip.style.display = "none"));

// Free-running display clock: advance the ring at RATE, draining queued samples and
// writing zeros when empty, so idle shows a flat line and a finished recording scrolls out instead of snapping to zero.
let lastAdvance = 0;
function advanceRing(now: number) {
  if (!lastAdvance) lastAdvance = now;
  let n = Math.floor(((now - lastAdvance) / 1000) * RATE);
  if (n > WINDOW) n = WINDOW; // don't over-catch-up after a tab pause
  // Drive spike processing off the same free-running display clock as the waveform, so the raster
  // scrolls continuously (zeros in when idle) like the Time view — gated to the active tab.
  const feedSpikes = view === "spikes" && spikesView.ready;
  for (let k = 0; k < n; k++) {
    const s = sampleQueue.shift();
    for (let c = 0; c < CH; c++) rings[c][writeIdx] = s ? s[c] : 0;
    if (feedSpikes) spikesView.feed(s ?? ZEROS);
    writeIdx = (writeIdx + 1) % WINDOW;
  }
  lastAdvance += (n / RATE) * 1000; // carry the sub-sample remainder
}

// --- Rendering (rAF, decoupled from BLE feed) ---
// advanceRing always runs so the time view is live the instant you switch back to it; the active tab decides which canvas we paint.
function draw() {
  advanceRing(performance.now());
  if (view === "freq") spectrumView.draw(M, specPtr, stream, CH, RATE);
  else if (view === "manifold") manifoldView.draw(M, specPtr, stream, CH);
  else if (view === "spikes") spikesView.draw(spikesStatus);
  else drawTime(canvases, rings, writeIdx, COLORS);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// --- WASM engine + BLE connection ---
let M: MudrakaModule | null = null;
let stream: Stream | null = null;
let dstPtr = 0;
let specPtr = 0;
let cursor = 0;
let device: BluetoothDevice | null = null;
let sncChar: BluetoothRemoteGATTCharacteristic | null = null;
let cmdChar: BluetoothRemoteGATTCharacteristic | null = null;

const MAX_PULL = 256;

// Shared decode path: raw SNC frame bytes in, decoded samples pushed to display — both the live BLE feed and the recorded-session playback go through here.
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
  const cfg = M.makeConfig(CH, RATE, 4);
  // Opt into the frequency-domain view. Ordinals passed as literals (WindowFn.hann=1, SpectrumOutput.power=1): const-enum values from the .d.ts don't survive esbuild transpile.
  M.enableSpectrum(cfg, SPEC_WINDOW, 1 /* hann */, 1 /* power µV² */, true /* µV */);
  stream = new M.Stream(cfg);
  cfg.delete(); // Stream copies the config; free the builder
  dstPtr = M._malloc(CH * MAX_PULL * 4);
  specPtr = M._malloc(CH * SPEC_BINS * 4);
  cursor = 0;
}

// Decode every fixture's raw SNC frames to per-channel sample arrays for Spike Trains W-learning.
// Uses a throwaway Stream per fixture (int32 raw counts via pullInto — same representation the live
// feed delivers, so learned thresholds transfer). Separate from the live stream; no interference.
async function decodeFixtures(): Promise<number[][][]> {
  if (!M) M = await createMudraka({ locateFile: () => wasmUrl });
  const sncUuid = uuid(CHAR_SNC);
  const out: number[][][] = [];
  for (const name of FIXTURES) {
    const dir = `${import.meta.env.BASE_URL}fixtures/${encodeURIComponent(name)}`;
    const [buf, index] = await Promise.all([
      fetch(`${dir}/capture.bin`).then((r) => r.arrayBuffer()),
      fetch(`${dir}/index.json`).then((r) => r.json()),
    ]);
    const bin = new Uint8Array(buf);
    const frames = (index.frames as Frame[]).filter((f) => f.uuid === sncUuid && f.dir === "rx");
    const cfg = M.makeConfig(CH, RATE, 8); // 8 s ring holds a whole fixture; we pull after every feed
    const st = new M.Stream(cfg);
    cfg.delete();
    const ptr = M._malloc(CH * MAX_PULL * 4);
    const base = ptr >> 2;
    const chans: number[][] = Array.from({ length: CH }, () => []);
    let cur = 0;
    for (const f of frames) {
      st.feed(bin.subarray(f.offset, f.offset + f.len), 0);
      for (;;) {
        const r = st.pullInto(cur, ptr, MAX_PULL);
        for (let i = 0; i < r.written; i++) for (let c = 0; c < CH; c++) chans[c].push(M.HEAP32[base + c * MAX_PULL + i]);
        cur = r.next_cursor;
        if (r.written < MAX_PULL) break;
      }
    }
    M._free(ptr);
    st.delete();
    out.push(chans);
  }
  return out;
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
  if (M && specPtr) { M._free(specPtr); specPtr = 0; }
  cursor = 0;
  sampleQueue.length = 0; // stop feeding; the clock scrolls zeros in on its own
  setBtn(connectBtn, ICON_BLUETOOTH, "Connect");
  connectBtn.classList.remove("connected");
  connectBtn.disabled = false;
  setBtn(playBtn, ICON_PLAY, "Play ▾");
  playBtn.classList.remove("connected");
  playBtn.disabled = false;
  recording = false;
  clearInterval(recTimer);
  if (bannerEl.textContent?.startsWith("●")) bannerEl.style.display = "none";
  setBtn(recordBtn, ICON_CIRCLE, "Record");
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
    // Reuse a retained device on reconnect instead of the chooser, which fails on macOS for this bonded, address-rotating band (docs/adr/0001).
    if (!device) {
      // getDevices() returns the already-granted device without scanning, so we can reconnect after a reload while macOS still holds the (non-advertising) link — needs Chrome flags, falls back to the chooser.
      // Match by stable id (name can be null for an OS-held device).
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
    setBtn(connectBtn, ICON_BLUETOOTH_OFF, "Disconnect");
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
  // Stop the stream before dropping GATT; leaving it streaming makes macOS refuse the next connect until "Forget This Device" — best-effort, link may be gone.
  try {
    await cmdChar?.writeValue(DISABLE_SNC);
    await sncChar?.stopNotifications();
  } catch { /* device already disconnected */ }
  device?.gatt?.disconnect(); // fires gattserverdisconnected -> cleanup
}

connectBtn.addEventListener("click", () =>
  connectBtn.classList.contains("connected") ? disconnect() : connect(),
);

// Tab close / reload: best-effort graceful stop before we go — the async write may not flush, but gatt.disconnect() drops the link; pagehide also covers bfcache nav.
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
// Replays a captured session's raw SNC frames through the same decode path as the live BLE feed, at the frames' recorded cadence — plays through once, then stops.
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
    const dir = `${import.meta.env.BASE_URL}fixtures/${encodeURIComponent(name)}`;
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
  setBtn(playBtn, ICON_SQUARE, "Stop");
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
// Free-form: Record starts stashing a copy of every live SNC frame, Stop ends it and downloads capture.bin + index.json in the same shape the playback loader above reads.
// Pure client-side download, identical on GitHub Pages and localhost — drop both files into public/fixtures/<your-name>/ (you name the folder) and rebuild to add a sample.
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
  setBtn(recordBtn, ICON_CIRCLE_REC, "Stop");
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
  setBtn(recordBtn, ICON_CIRCLE, "Record");
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

const enc = new TextEncoder();

function save(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

recordBtn.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
