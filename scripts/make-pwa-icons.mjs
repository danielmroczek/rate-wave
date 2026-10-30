// Generuje rasterowe ikony PWA (192/512, purpose any+maskable) z public/icons/favicon.svg.
// Raster zaplecza potrzebny do niezawodnej instalowalności Chrome/Android (review biletu 01:
// sama ikona SVG "any" ryzykuje niepowodzenie AC). Zero zależności: własny mini-encoder PNG
// (zlib) — historycznie scripts/make-icons.mjs, ścieżka przeniesiona do public/icons po reworku.
// Uruchamianie: vp exec node scripts/make-pwa-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svgText = readFileSync(join(here, "..", "public", "icons", "favicon.svg"), "utf8");

// Prosty parser tego konkretnego SVG: rect gradient + białe kreski (path "M…", stroke).
const grad = [...svgText.matchAll(/stop-color="([^"]+)"/g)].map((m) => m[1]);
const rx = Number((svgText.match(/rx="(\d+)"/) ?? [])[1] ?? 0);
const paths = [...svgText.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const strokeWidth = Number(
  (svgText.match(/stroke-width="(\d+(?:\.\d+)?)"(?!-line)/) ?? [])[1] ?? 0,
);

function hex(hx) {
  const v = parseInt(hx.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Rasterizacja: supersampling 4× na piksel docelowy (prosty area sampling).
function render(size) {
  const S = 32; // viewBox
  const ss = 4;
  const N = size * ss;
  const cov = new Float32Array(size * size); // coverage białych kreskek
  const col = new Uint8Array(size * size * 3); // kolor tła (gradient)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = ((x * ss + sx + 0.5) / N) * S;
          const py = ((y * ss + sy + 0.5) / N) * S;
          for (const d of paths) {
            if (pathHit(d, px, py, strokeWidth)) {
              hit++;
              break;
            }
          }
        }
      }
      cov[y * size + x] = hit / (ss * ss);
      // gradient odpowiada rect fill (x1 15% y1 15% → x2 85% y2 85%)
      const t = Math.min(1, Math.max(0, (px(x, size) + py(y, size)) / (2 * size)));
      const c = lerp(hex(grad[0]), hex(grad[1]), t);
      col[(y * size + x) * 3] = c[0];
      col[(y * size + x) * 3 + 1] = c[1];
      col[(y * size + x) * 3 + 2] = c[2];
    }
  }
  return { size, cov, col };
}
function px(x, size) {
  return (x + 0.5) * (32 / size);
}
function py(y, size) {
  return (y + 0.5) * (32 / size);
}

// pathHit — test przecięcia segmentu pathu z kwadratem o boku strokeWidth/2 wokół punktu.
function pathSegs(d) {
  // tabler waveform używa wyłącznie absolutnych M + v/V (pionowe) — nasza ikona tak właśnie
  // wygląda ("M5.5 14v3.9M10.75 9.4v13.1…"); wspieramy M/m + v/V + h/H (wystarczająco).
  const segs = [];
  const re = /([MmVvHh])([^MmVvHh]*)/g;
  let cx = 0,
    cy = 0;
  const nums = (s) =>
    s
      .trim()
      .match(/[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/g)
      ?.map(Number) ?? [];
  for (const m of d.matchAll(re)) {
    const cmd = m[1];
    const args = nums(m[2]);
    if (cmd === "M" || cmd === "m") {
      for (let i = 0; i < args.length; i += 2) {
        const nx = cmd === "M" ? args[i] : cx + args[i];
        const ny = cmd === "M" ? args[i + 1] : cy + args[i + 1];
        if (i === 0) {
          cx = nx;
          cy = ny;
        } else segs.push({ x1: cx, y1: cy, x2: nx, y2: ny });
        cx = nx;
        cy = ny;
      }
    } else if (cmd === "v" || cmd === "V") {
      for (const ny of args.map((n) => (cmd === "V" ? n : cy + n))) {
        segs.push({ x1: cx, y1: cy, x2: cx, y2: ny });
        cy = ny;
      }
    } else if (cmd === "h" || cmd === "H") {
      for (const nx of args.map((n) => (cmd === "H" ? n : cx + n))) {
        segs.push({ x1: cx, y1: cy, x2: nx, y2: cy });
        cx = nx;
      }
    }
  }
  return segs;
}

function pathHit(d, qx, qy, w) {
  const half = w / 2;
  for (const s of pathSegs(d)) {
    // odległość punktu od odcinka
    const dx = s.x2 - s.x1,
      dy = s.y2 - s.y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((qx - s.x1) * dx + (qy - s.y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const ex = s.x1 + t * dx - qx,
      ey = s.y1 + t * dy - qy;
    if (ex * ex + ey * ey <= half * half) return true;
  }
  return false;
}

// ——— PNG encoder (RGBA, filter 0) ———
function crc32(buf) {
  let c,
    table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 255];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(img) {
  const { size, cov, col } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4 + 1 + y; // +1 na filter byte per wiersz
      const a = Math.round(cov[y * size + x] * 255);
      raw[i] = 255;
      raw[i + 1] = 255;
      raw[i + 2] = 255;
      raw[i + 3] = a;
    }
  }
  // tło: gradient pod białymi kreskami, alpha=255 poza kreskami też (maskable wypełnia tile)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = y * (size * 4 + 1) + 1 + x * 4;
      const a = raw[p + 3] / 255;
      raw[p] = Math.round(col[(y * size + x) * 3] * (1 - a) + raw[p] * a);
      raw[p + 1] = Math.round(col[(y * size + x) * 3 + 1] * (1 - a) + raw[p + 1] * a);
      raw[p + 2] = Math.round(col[(y * size + x) * 3 + 2] * (1 - a) + raw[p + 2] * a);
      raw[p + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const out = join(here, "..", "public", "icons", `icon-${size}.png`);
  writeFileSync(out, png(render(size)));
  console.log("written", out);
}
