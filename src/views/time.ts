// --- Time-domain waveform view ---
// Mudra Link SNC is fixed 16-bit signed (docs); pin the amplitude to the full range.
const AMP_HALF = 32768 * 1.1;

// One canvas per channel, oldest sample at left, newest at right.
export function drawTime(canvases: HTMLCanvasElement[], rings: Float32Array[], writeIdx: number, colors: string[]) {
  for (let c = 0; c < canvases.length; c++) {
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

    ctx.strokeStyle = "#e0ddd0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.strokeStyle = colors[c];
    ctx.lineWidth = dpr;
    ctx.beginPath();
    for (let k = 0; k < ring.length; k++) {
      const v = ring[(writeIdx + k) % ring.length];
      const x = (k / (ring.length - 1)) * w;
      const y = h / 2 - (v / half) * (h / 2);
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
