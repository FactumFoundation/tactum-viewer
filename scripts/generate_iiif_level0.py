"""
Static IIIF Image API 3.0 (level0) packager.

Converts an existing TMS tile pyramid ({channel}/{z}/{col}/{row}.png, as
produced by the tile generators) into a static Image API level-0 tree:

  {out}/{channel}/info.json
  {out}/{channel}/{x},{y},{w},{h}/{tw},{th}/0/default.png     (tiles)
  {out}/{channel}/full/{w},{h}/0/default.png                  (thumbnail sizes)

No source TIF needed: TMS tiles are zero-padded past the image boundary, so
IIIF edge tiles are produced by cropping the existing tiles to the image
bounds. Interior tiles are pixel-identical (re-encoded PNGs).

Usage:
  python scripts/generate_iiif_level0.py \
      --metadata public/moss/metadata.json \
      --base-url http://localhost:5173/moss/iiif
"""

import argparse
import json
import math
import os
import time

import numpy as np
from PIL import Image

TILE = 256
# full-image downsamples shipped as /full/{w},{h}/ (largest first in info.json "sizes")
THUMB_SCALE_FACTORS = [64, 32, 16, 8]


def full_sizes(width, height, max_level):
    """(scaleFactor, w, h) for the shipped full-image sizes, small to large."""
    out = []
    for sf in sorted(THUMB_SCALE_FACTORS, reverse=True):
        if sf > 2 ** max_level:
            continue
        out.append((sf, math.ceil(width / sf), math.ceil(height / sf)))
    return out


def crop_or_pad(arr, th, tw):
    """Crop tile array to (th, tw); edge-replicate if a row/col short (≤1 px)."""
    arr = arr[:th, :tw]
    pad_h = th - arr.shape[0]
    pad_w = tw - arr.shape[1]
    if pad_h or pad_w:
        arr = np.pad(arr, ((0, pad_h), (0, pad_w), (0, 0)), mode='edge')
    return arr


def package_channel(channel, src_dir, out_dir, metadata, base_url):
    W, H = metadata['imageWidth'], metadata['imageHeight']
    max_level = metadata['maxLevel']
    ch_out = os.path.join(out_dir, channel)
    n_tiles = 0

    # ── Tiles ──────────────────────────────────────────────────────────────
    for z in range(max_level + 1):
        sf = 2 ** (max_level - z)
        level_dir = os.path.join(src_dir, channel, str(z))
        if not os.path.isdir(level_dir):
            continue
        for col_name in os.listdir(level_dir):
            col = int(col_name)
            for row_file in os.listdir(os.path.join(level_dir, col_name)):
                row = int(os.path.splitext(row_file)[0])
                x0, y0 = col * TILE * sf, row * TILE * sf
                if x0 >= W or y0 >= H:
                    continue
                rw, rh = min(TILE * sf, W - x0), min(TILE * sf, H - y0)
                tw, th = math.ceil(rw / sf), math.ceil(rh / sf)

                src = os.path.join(level_dir, col_name, row_file)
                arr = np.asarray(Image.open(src))
                if (th, tw) != arr.shape[:2]:
                    arr = crop_or_pad(arr, th, tw)

                dest_dir = os.path.join(ch_out, f'{x0},{y0},{rw},{rh}', f'{tw},{th}', '0')
                os.makedirs(dest_dir, exist_ok=True)
                Image.fromarray(arr).save(os.path.join(dest_dir, 'default.png'), compress_level=6)
                n_tiles += 1

    # ── Full-image sizes (assembled from the pyramid level of each factor) ──
    sizes = []
    for sf, w, h in full_sizes(W, H, max_level):
        z = max_level - int(math.log2(sf))
        n = 2 ** z
        mosaic = np.zeros((n * TILE, n * TILE, 3), dtype=np.uint8)
        for col in range(n):
            for row in range(n):
                src = os.path.join(src_dir, channel, str(z), str(col), f'{row}.png')
                if os.path.exists(src):
                    mosaic[row * TILE:(row + 1) * TILE, col * TILE:(col + 1) * TILE] = \
                        np.asarray(Image.open(src))[:, :, :3]
        arr = crop_or_pad(mosaic, h, w)
        dest_dir = os.path.join(ch_out, 'full', f'{w},{h}', '0')
        os.makedirs(dest_dir, exist_ok=True)
        Image.fromarray(arr).save(os.path.join(dest_dir, 'default.png'), compress_level=6)
        sizes.append({'width': w, 'height': h})

    # /full/max is REQUIRED at compliance level 0. With maxWidth/maxHeight
    # declared, "max" resolves to the largest shipped size, so copy it.
    max_w, max_h = sizes[-1]['width'], sizes[-1]['height']
    max_dir = os.path.join(ch_out, 'full', 'max', '0')
    os.makedirs(max_dir, exist_ok=True)
    largest = os.path.join(ch_out, 'full', f'{max_w},{max_h}', '0', 'default.png')
    with open(largest, 'rb') as src_f, open(os.path.join(max_dir, 'default.png'), 'wb') as dst_f:
        dst_f.write(src_f.read())

    # ── info.json ───────────────────────────────────────────────────────────
    info = {
        '@context': 'http://iiif.io/api/image/3/context.json',
        'id': f'{base_url}/{channel}',
        'type': 'ImageService3',
        'protocol': 'http://iiif.io/api/image',
        'profile': 'level0',
        'width': W,
        'height': H,
        'maxWidth': max_w,
        'maxHeight': max_h,
        'tiles': [{
            'width': TILE,
            'height': TILE,
            'scaleFactors': [2 ** i for i in range(max_level + 1)],
        }],
        'sizes': sizes,
        'preferredFormats': ['png'],
    }
    os.makedirs(ch_out, exist_ok=True)
    with open(os.path.join(ch_out, 'info.json'), 'w') as f:
        json.dump(info, f, indent=2)

    return n_tiles


def main():
    parser = argparse.ArgumentParser(description='Package a TMS pyramid as static IIIF Image API level 0.')
    parser.add_argument('--metadata', required=True, help='path to metadata.json (TMS pyramid lives beside it)')
    parser.add_argument('--base-url', required=True, help='public base URL of the IIIF tree (no trailing slash)')
    parser.add_argument('--out', help='output dir (default: "iiif" beside metadata.json)')
    parser.add_argument('--channels', nargs='*', help='channels to package (default: all in metadata)')
    args = parser.parse_args()

    with open(args.metadata) as f:
        metadata = json.load(f)

    src_dir = os.path.dirname(os.path.abspath(args.metadata))
    out_dir = args.out or os.path.join(src_dir, 'iiif')
    base_url = args.base_url.rstrip('/')
    channels = args.channels or metadata['channels']

    t0 = time.time()
    for channel in channels:
        n = package_channel(channel, src_dir, out_dir, metadata, base_url)
        print(f'  {channel}: {n} tiles + {len(THUMB_SCALE_FACTORS)} sizes + info.json [{time.time() - t0:.1f}s]')
    print(f'Done. IIIF level-0 tree at {out_dir}')


if __name__ == '__main__':
    main()
