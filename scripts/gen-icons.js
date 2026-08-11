#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'web');
const DESIGN = 32;
const BG = [18, 22, 29];
const FG = [79, 140, 255];

const LEFT_EAR = [[11, 1], [13.5, 1], [16, 9.5]];
const RIGHT_EAR = [[16, 9.5], [18.5, 1], [21, 1]];
const LEFT_WING = [[12, 11], [16, 11], [2, 16], [0.5, 20], [4, 18], [5, 23], [8, 19], [9, 24], [12, 20], [13, 15]];
const BODY = [[12.5, 13.5], [19.5, 13.5], [18, 20], [14, 20]];
const TAIL = [[14, 20], [18, 20], [16, 25]];
const HEAD = { cx: 16, cy: 10.5, r: 4 };
const EYES = [{ cx: 13, cy: 9.5, r: 1.15 }, { cx: 19, cy: 9.5, r: 1.15 }];

function mirror(pts) {
  return pts.map(([x, y]) => [DESIGN - x, y]);
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function mask(x, y) {
  let filled = false;
  if (inPolygon(x, y, LEFT_EAR) || inPolygon(x, y, RIGHT_EAR)) filled = true;
  if (inPolygon(x, y, LEFT_WING) || inPolygon(x, y, mirror(LEFT_WING))) filled = true;
  if (inPolygon(x, y, BODY) || inPolygon(x, y, TAIL)) filled = true;
  if (inCircle(x, y, HEAD.cx, HEAD.cy, HEAD.r)) filled = true;
  if (filled) {
    for (const e of EYES) {
      if (inCircle(x, y, e.cx, e.cy, e.r)) filled = false;
    }
  }
  return filled;
}

let cachedBbox = null;
function bbox() {
  if (cachedBbox) return cachedBbox;
  let minX = DESIGN;
  let minY = DESIGN;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y <= DESIGN; y += 1 / 8) {
    for (let x = 0; x <= DESIGN; x += 1 / 8) {
      if (mask(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  cachedBbox = { minX, minY, maxX, maxY };
  return cachedBbox;
}

function inRoundedRect(x, y, size, r) {
  const lx = Math.min(Math.max(x, r), size - r);
  const ly = Math.min(Math.max(y, r), size - r);
  const dx = x - lx;
  const dy = y - ly;
  return dx * dx + dy * dy <= r * r;
}

function render(size, opts = {}) {
  const rounded = opts.rounded !== false;
  const radius = opts.radius || 0.18;
  const b = bbox();
  const bW = b.maxX - b.minX;
  const bH = b.maxY - b.minY;
  const scale = size / Math.max(bW, bH);
  const dx = (size - bW * scale) / 2 - b.minX * scale;
  const dy = (size - bH * scale) / 2 - b.minY * scale;
  const SS = 4;
  const corner = rounded ? radius * size : 0;
  const buf = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const o = (py * size + px) * 4;
      if (rounded) {
        if (!inRoundedRect(px + 0.5, py + 0.5, size, corner)) {
          buf[o] = 0;
          buf[o + 1] = 0;
          buf[o + 2] = 0;
          buf[o + 3] = 0;
          continue;
        }
      }
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (px + (sx + 0.5) / SS - dx) / scale;
          const fy = (py + (sy + 0.5) / SS - dy) / scale;
          if (mask(fx, fy)) cov++;
        }
      }
      const a = cov / (SS * SS);
      buf[o] = Math.round(BG[0] * (1 - a) + FG[0] * a);
      buf[o + 1] = Math.round(BG[1] * (1 - a) + FG[1] * a);
      buf[o + 2] = Math.round(BG[2] * (1 - a) + FG[2] * a);
      buf[o + 3] = 255;
    }
  }
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(rgba, size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dirs = [];
  const blobs = [];
  let offset = 6 + pngs.length * 16;
  for (const p of pngs) {
    const d = Buffer.alloc(16);
    d[0] = p.size >= 256 ? 0 : p.size;
    d[1] = p.size >= 256 ? 0 : p.size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(p.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += p.png.length;
    dirs.push(d);
    blobs.push(p.png);
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

function polyPath(pts) {
  return pts.map((p, i) => (i === 0 ? `M${p[0]} ${p[1]}` : `L${p[0]} ${p[1]}`)).join(' ') + ' Z';
}

function glyphSvg() {
  const glyphPath =
    polyPath(LEFT_EAR) + ' ' + polyPath(RIGHT_EAR) + ' ' +
    polyPath(LEFT_WING) + ' ' + polyPath(mirror(LEFT_WING)) + ' ' +
    polyPath(BODY) + ' ' + polyPath(TAIL);
  const eyes = EYES.map(e => `<circle cx="${e.cx}" cy="${e.cy}" r="${e.r}" fill="#12161d"/>`).join('\n  ');
  return { glyphPath, eyes };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const png = (size, rounded) => encodePng(render(size, { rounded }), size);

  fs.writeFileSync(path.join(OUT_DIR, 'favicon-16x16.png'), png(16, true));
  fs.writeFileSync(path.join(OUT_DIR, 'favicon-32x32.png'), png(32, true));
  fs.writeFileSync(path.join(OUT_DIR, 'apple-touch-icon.png'), png(180, false));
  fs.writeFileSync(path.join(OUT_DIR, 'android-chrome-192x192.png'), png(192, true));
  fs.writeFileSync(path.join(OUT_DIR, 'android-chrome-512x512.png'), png(512, true));

  const ico = encodeIco([
    { size: 16, png: png(16, true) },
    { size: 32, png: png(32, true) },
    { size: 48, png: png(48, true) },
  ]);
  fs.writeFileSync(path.join(OUT_DIR, 'favicon.ico'), ico);

  const { glyphPath, eyes } = glyphSvg();
  const faviconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#12161d"/>
  <path d="${glyphPath}" fill="#4f8cff"/>
  ${eyes}
</svg>
`;
  fs.writeFileSync(path.join(OUT_DIR, 'favicon.svg'), faviconSvg);

  const pinnedSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="${glyphPath}" fill="#000000"/>
  <circle cx="13" cy="9.5" r="1.15" fill="none"/>
  <circle cx="19" cy="9.5" r="1.15" fill="none"/>
</svg>
`;
  fs.writeFileSync(path.join(OUT_DIR, 'safari-pinned-tab.svg'), pinnedSvg);

  const manifest = {
    name: 'Alfred — Control panel',
    short_name: 'Alfred',
    start_url: '/',
    display: 'standalone',
    background_color: '#12161d',
    theme_color: '#12161d',
    icons: [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
  fs.writeFileSync(path.join(OUT_DIR, 'site.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

  console.log('Icons generated in', OUT_DIR);
}

main();
