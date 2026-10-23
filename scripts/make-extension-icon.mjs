// Draws the extension's Marketplace icon (extensions/vscode/media/icon.png) with no dependencies:
// a rounded square in the app's violet-to-sky gradient with a white architecture-graph glyph
// (one box fanning out to three, like a dependency tree). Run: node scripts/make-extension-icon.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 256; // the Marketplace wants at least 128 px; 256 stays sharp on high-DPI screens
const SS = 4; // supersampling factor for smooth edges
const W = SIZE * SS;

const violet = [139, 92, 246];
const sky = [14, 165, 233];

/** Signed distance to a rounded rectangle centred at (cx, cy); negative inside. */
function roundedRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Signed distance to a thick line segment (a capsule). */
function capsule(x, y, ax, ay, bx, by, r) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t) - r;
}

// Geometry in unit coordinates (0..1), scaled to the canvas.
const u = (v) => v * W;
const boxes = [
  { cx: 0.5, cy: 0.3, hw: 0.14, hh: 0.09 }, // root
  { cx: 0.24, cy: 0.74, hw: 0.11, hh: 0.075 },
  { cx: 0.5, cy: 0.74, hw: 0.11, hh: 0.075 },
  { cx: 0.76, cy: 0.74, hw: 0.11, hh: 0.075 },
];
const links = boxes.slice(1).map((b) => [0.5, 0.3 + 0.09, b.cx, b.cy - 0.075]);

const pixels = new Float32Array(W * W * 4);
for (let py = 0; py < W; py++) {
  for (let px = 0; px < W; px++) {
    const x = px + 0.5;
    const y = py + 0.5;
    const tile = roundedRect(x, y, W / 2, W / 2, W / 2 - u(0.02), W / 2 - u(0.02), u(0.2));
    if (tile > 0) continue; // outside the tile: transparent
    const t = (x + y) / (2 * W); // diagonal gradient
    let color = violet.map((c, i) => c + (sky[i] - c) * t);
    let coverage = 0;
    for (const b of boxes) coverage = Math.max(coverage, roundedRect(x, y, u(b.cx), u(b.cy), u(b.hw), u(b.hh), u(0.03)) < 0 ? 1 : 0);
    for (const [ax, ay, bx, by] of links) coverage = Math.max(coverage, capsule(x, y, u(ax), u(ay), u(bx), u(by), u(0.012)) < 0 ? 1 : 0);
    if (coverage) color = [255, 255, 255];
    const o = (py * W + px) * 4;
    pixels[o] = color[0];
    pixels[o + 1] = color[1];
    pixels[o + 2] = color[2];
    pixels[o + 3] = 255;
  }
}

// Downsample SSxSS blocks, weighting colour by alpha so the rounded edge stays clean.
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const o = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        const alpha = pixels[o + 3];
        r += pixels[o] * alpha;
        g += pixels[o + 1] * alpha;
        b += pixels[o + 2] * alpha;
        a += alpha;
      }
    }
    const o = (y * SIZE + x) * 4;
    if (a > 0) {
      rgba[o] = Math.round(r / a);
      rgba[o + 1] = Math.round(g / a);
      rgba[o + 2] = Math.round(b / a);
    }
    rgba[o + 3] = Math.round(a / (SS * SS));
  }
}

// ---------- PNG encoding ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("extensions/vscode/media", { recursive: true });
writeFileSync("extensions/vscode/media/icon.png", png);
console.log(`wrote extensions/vscode/media/icon.png (${SIZE}x${SIZE}, ${png.length} bytes)`);
