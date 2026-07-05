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
export function zip(files: { name: string; data: Uint8Array }[]) {
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
