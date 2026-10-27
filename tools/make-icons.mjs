// Renders the extension icons (a terracotta tile with an open "c" stroke and
// a dot) to PNG without any image dependencies. Usage: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../extension/icons');
const SS = 4; // supersampling per axis

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape coverage in unit space [0,1]^2: returns [tileAlpha, glyphAlpha].
function sample(x, y) {
  const r = 0.23;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  const inTile = Math.hypot(qx, qy) <= r;
  if (!inTile) return [0, 0];
  const cx = 0.47;
  const cy = 0.5;
  const d = Math.hypot(x - cx, y - cy);
  const angle = Math.atan2(y - cy, x - cx);
  const onRing = Math.abs(d - 0.22) <= 0.068 && Math.abs(angle) > 0.78;
  const dot = Math.hypot(x - 0.735, y - 0.5) <= 0.068;
  return [1, onRing || dot ? 1 : 0];
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const top = [0xdb, 0x7b, 0x5a];
  const bottom = [0xc2, 0x5a, 0x3a];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let glyph = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [t, g] = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          tile += t;
          glyph += g;
        }
      }
      tile /= SS * SS;
      glyph /= SS * SS;
      const k = py / size;
      const base = top.map((c, i) => c + (bottom[i] - c) * k);
      const mix = glyph / Math.max(tile, 1e-6);
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(base[c] + (255 - base[c]) * mix);
      buf[i + 3] = Math.round(tile * 255);
    }
  }
  return buf;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(outDir, `icon${size}.png`), png(size, render(size)));
}
console.log('icons written to', outDir);
