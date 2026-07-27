"""TMS tile pyramid generator.

Reads a dataset directory (dataset.json + 16-bit height PNGs + 8-bit albedo
PNG, see data/sample/) and generates the tile pyramid the viewer consumes:

  - height channels: RGB PNG, R = high byte, G = low byte of the 16-bit value
  - albedo:          8-bit RGB PNG

The canvas is the smallest power-of-two square that contains the image; the
image sits at the top-left corner and tiles fully outside it are skipped.

Usage:  uv run python scripts/generate_tiles.py [--src data/sample]
                                                [--out public/moss]
"""

import argparse
import json
import math
import os
import time

import numpy as np
from PIL import Image

TILE = 256
Image.MAX_IMAGE_PIXELS = None


def load_dataset(src_dir):
    """Read dataset.json and all channel images. Returns (ds, channels)."""
    with open(os.path.join(src_dir, 'dataset.json')) as f:
        ds = json.load(f)
    channels = {}
    for name, hc in ds['heightChannels'].items():
        arr = np.asarray(Image.open(os.path.join(src_dir, hc['file'])))
        channels[name] = (arr.astype(np.uint16), 'height16')
    albedo = np.asarray(Image.open(os.path.join(src_dir, ds['albedo'])))
    channels['albedo'] = (albedo.astype(np.uint8), 'rgb8')

    # Validate that all channels have the same (h, w) as albedo
    albedo_h, albedo_w = albedo.shape[:2]
    for name, (arr, kind) in channels.items():
        if name == 'albedo':
            continue
        ch_h, ch_w = arr.shape[:2]
        if (ch_h, ch_w) != (albedo_h, albedo_w):
            raise SystemExit(
                f'{name} {(ch_h, ch_w)} does not match albedo {(albedo_h, albedo_w)}'
            )

    return ds, channels


def canvas_for(w, h):
    """Smallest power-of-two canvas that holds the image (min: one tile)."""
    size = TILE
    while size < max(w, h):
        size *= 2
    return size


def build_metadata(ds, img_w, img_h, canvas):
    max_level = int(math.log2(canvas // TILE))
    height_fields = {}
    for name, hc in ds['heightChannels'].items():
        height_fields[name] = {
            'heightRangeMM': hc['heightRangeMM'],
            'zScale': hc['heightRangeMM'] / (canvas * ds['pixelSizeMM']),
        }
    default = ds['defaultHeightChannel']
    return {
        'tileSize': TILE,
        'canvasSize': canvas,
        'maxLevel': max_level,
        'imageWidth': img_w,
        'imageHeight': img_h,
        'pixelSizeMM': ds['pixelSizeMM'],
        'heightRangeMM': height_fields[default]['heightRangeMM'],
        'minValue': 0,
        'maxValue': 65535,
        'channels': list(ds['heightChannels'].keys()) + ['albedo'],
        'worldWidth': 1.0,
        'worldHeight': 1.0,
        'dataRegion': {
            'x': 0,
            'z': 0,
            'width': img_w / canvas,
            'height': img_h / canvas,
        },
        'zScale': height_fields[default]['zScale'],
        'defaultHeightChannel': default,
        'heightFields': height_fields,
    }


def generate(channels, metadata, out_dir):
    """Write metadata.json and the full pyramid. Returns tile-position count."""
    img_w = metadata['imageWidth']
    img_h = metadata['imageHeight']
    canvas = metadata['canvasSize']

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    t0 = time.time()
    total_tiles = 0
    for z in range(metadata['maxLevel'] + 1):
        n = 2 ** z
        tile_src_size = canvas / n
        level_tiles = 0
        for col in range(n):
            src_x0 = col * tile_src_size
            if src_x0 >= img_w:
                continue
            for row in range(n):
                src_y0 = row * tile_src_size
                if src_y0 >= img_h:
                    continue

                # Edge-to-edge sampling: boundary shared with neighbours
                xs = np.linspace(src_x0, src_x0 + tile_src_size, TILE)
                ys = np.linspace(src_y0, src_y0 + tile_src_size, TILE)
                xi = np.round(xs).astype(np.intp)
                yi = np.round(ys).astype(np.intp)
                x_oob = xi >= img_w
                y_oob = yi >= img_h
                gy, gx = np.meshgrid(np.clip(yi, 0, img_h - 1),
                                     np.clip(xi, 0, img_w - 1), indexing='ij')
                oob = np.zeros((TILE, TILE), dtype=bool)
                oob[y_oob, :] = True
                oob[:, x_oob] = True

                for name, (arr, kind) in channels.items():
                    px = arr[gy, gx].copy()
                    px[oob] = 0
                    if kind == 'height16':
                        hi = (px >> 8).astype(np.uint8)
                        lo = (px & 0xFF).astype(np.uint8)
                        px = np.stack([hi, lo, np.zeros_like(hi)], axis=-1)
                    ch_dir = os.path.join(out_dir, name, str(z), str(col))
                    os.makedirs(ch_dir, exist_ok=True)
                    Image.fromarray(px).save(
                        os.path.join(ch_dir, f'{row}.png'), compress_level=6)
                level_tiles += 1
        total_tiles += level_tiles
        print(f'  Level {z}: {level_tiles} tiles ({n}x{n} grid) '
              f'[{time.time() - t0:.1f}s]')
    return total_tiles


def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = argparse.ArgumentParser(description='Generate a TMS tile pyramid.')
    p.add_argument('--src', default=os.path.join(repo, 'data', 'sample'))
    p.add_argument('--out', default=os.path.join(repo, 'public', 'moss'))
    args = p.parse_args()

    ds, channels = load_dataset(args.src)
    img_h, img_w = channels['albedo'][0].shape[:2]
    metadata = build_metadata(ds, img_w, img_h, canvas_for(img_w, img_h))
    print(f'{ds["name"]}: {img_w}x{img_h}, canvas {metadata["canvasSize"]}, '
          f'levels 0..{metadata["maxLevel"]}')
    total = generate(channels, metadata, args.out)

    # The demo's InfoOverlay fetches info.json next to the tiles
    info_src = os.path.join(args.src, 'info.json')
    if os.path.exists(info_src):
        with open(info_src) as f:
            info = f.read()
        with open(os.path.join(args.out, 'info.json'), 'w') as f:
            f.write(info)
    print(f'Done! {total} tile positions x {len(channels)} channels')


if __name__ == '__main__':
    main()
