/**
 * Tile pyramid generator.
 *
 * Generates a TMS-style tile pyramid in public/tiles/{z}/{col}/{row}.png
 * using Perlin noise coloured with the viridis colormap, with tile labels
 * rendered as black text overlay.
 *
 * Usage:  node scripts/generate-tiles.js
 *         npm run generate-tiles
 */

import sharp from 'sharp';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { parseArgs } from './lib/args.js';

const TILE = 256;
const SOURCE_SIZE = 20000;
const MAX_Z = 7; // ceil(log2(20000/256)): max useful level

const OUT_DIR = parseArgs(process.argv.slice(2), {
  out: join(process.cwd(), 'public', 'tiles'),
}).out;
const BATCH = 200; // concurrent sharp operations

// ── Viridis colormap (matplotlib) ────────────────────────────────────────
// Sampled at 9 stops from the canonical viridis LUT

const VIRIDIS = [
  [0.000,  68,   1,  84],
  [0.125,  72,  35, 116],
  [0.250,  64,  67, 135],
  [0.375,  52,  94, 141],
  [0.500,  33, 145, 140],
  [0.625,  53, 183, 121],
  [0.750, 109, 205,  89],
  [0.875, 180, 222,  44],
  [1.000, 253, 231,  37],
];

function colormap(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < VIRIDIS.length - 1; i++) {
    if (t <= VIRIDIS[i + 1][0]) {
      const f = (t - VIRIDIS[i][0]) / (VIRIDIS[i + 1][0] - VIRIDIS[i][0]);
      return [
        Math.round(VIRIDIS[i][1] + f * (VIRIDIS[i + 1][1] - VIRIDIS[i][1])),
        Math.round(VIRIDIS[i][2] + f * (VIRIDIS[i + 1][2] - VIRIDIS[i][2])),
        Math.round(VIRIDIS[i][3] + f * (VIRIDIS[i + 1][3] - VIRIDIS[i][3])),
      ];
    }
  }
  return [253, 231, 37];
}

// ── Perlin noise ─────────────────────────────────────────────────────────
// Classic 2D Perlin noise (improved, Ken Perlin 2002)

const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates shuffle with fixed seed for reproducibility
  let seed = 42;
  const rng = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

const GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }

function dot2(g, x, y) { return g[0] * x + g[1] * y; }

function perlin2(x, y) {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);

  const aa = PERM[PERM[xi] + yi], ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi], bb = PERM[PERM[xi + 1] + yi + 1];

  return lerp(
    lerp(dot2(GRAD[aa & 7], xf, yf),     dot2(GRAD[ba & 7], xf - 1, yf), u),
    lerp(dot2(GRAD[ab & 7], xf, yf - 1), dot2(GRAD[bb & 7], xf - 1, yf - 1), u),
    v,
  );
}

/** Fractal Brownian Motion: sum of octaves of Perlin noise */
function fbm(x, y, octaves = 6) {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * perlin2(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

// ── Pixel generation ─────────────────────────────────────────────────────

function generatePixels(z, col, row) {
  const n = 2 ** z;
  const x0 = col / n, y0 = row / n;
  const step = 1 / (n * TILE);

  const buf = Buffer.alloc(TILE * TILE * 3);

  for (let py = 0; py < TILE; py++) {
    const y = y0 + (py + 0.5) * step;
    for (let px = 0; px < TILE; px++) {
      const x = x0 + (px + 0.5) * step;

      // Scale coordinates for interesting noise detail
      const noise = fbm(x * 8 + 0.5, y * 8 + 0.5, 6);
      // Map from [-0.5..0.5] range to [0..1]
      const t = noise + 0.5;

      const [r, g, b] = colormap(t);
      const i = (py * TILE + px) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
  return buf;
}

// ── SVG text overlay (black text) ────────────────────────────────────────

function textOverlay(z, col, row) {
  const worldSize = Math.round(SOURCE_SIZE / (2 ** z));
  return Buffer.from(`<svg width="${TILE}" height="${TILE}" xmlns="http://www.w3.org/2000/svg">
    <text x="${TILE / 2}" y="${TILE / 2 - 8}" text-anchor="middle"
          font-family="monospace" font-size="16" font-weight="bold"
          fill="rgba(0,0,0,0.55)">L${z} [${col},${row}]</text>
    <text x="${TILE / 2}" y="${TILE / 2 + 14}" text-anchor="middle"
          font-family="monospace" font-size="11"
          fill="rgba(0,0,0,0.45)">${worldSize}\u00d7${worldSize}</text>
  </svg>`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  let total = 0;
  for (let z = 0; z <= MAX_Z; z++) total += 4 ** z;

  console.log(`Generating ${total} tiles (levels 0-${MAX_Z}) → ${OUT_DIR}\n`);
  const t0 = Date.now();

  for (let z = 0; z <= MAX_Z; z++) {
    const n = 2 ** z;
    const tasks = [];

    for (let col = 0; col < n; col++) {
      const dir = join(OUT_DIR, String(z), String(col));
      mkdirSync(dir, { recursive: true });

      for (let row = 0; row < n; row++) {
        const pixels = generatePixels(z, col, row);
        const overlay = textOverlay(z, col, row);
        const outPath = join(dir, `${row}.png`);

        tasks.push(
          sharp(pixels, { raw: { width: TILE, height: TILE, channels: 3 } })
            .composite([{ input: overlay, top: 0, left: 0 }])
            .png({ compressionLevel: 6 })
            .toFile(outPath)
        );

        if (tasks.length >= BATCH) {
          await Promise.all(tasks);
          tasks.length = 0;
        }
      }
    }

    await Promise.all(tasks);
    console.log(`  Level ${z}: ${n}\u00d7${n} = ${n * n} tiles`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone! ${total} tiles in ${elapsed}s`);
}

main().catch(console.error);
