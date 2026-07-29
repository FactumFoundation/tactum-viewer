"""Convert scanner output into a Tactum Viewer dataset.

Reads a source directory with one or more floating point height channel
TIFFs (in metres) and a uint16 RGB albedo TIFF, optionally decimates them,
and writes:

  - <name>.png for each height channel: 16-bit greyscale, normalised to
    the full uint16 range
  - albedo.png: 8-bit RGB
  - dataset.json: manifest consumed by scripts/generate_tiles.py

The converter only scales and quantises the data you give it. It does not
filter, crop or otherwise change what the scanner produced. If your source
is a single raw depthmap and you want a separate high pass relief channel,
derive that first with scripts/extract_hf_relief.py and pass the result in as
another --channel.

Sample recipe (the bundled sample in data/sample was made like this, from
a 4096px centre crop, not in git, of: nature-printed moss, Alois Auer,
"Der polygraphische Apparat", Vienna, 1853. From the private collection of
Adam Lowe.):

  uv run python scripts/extract_hf_relief.py \\
      --src data/crop_center_4096/depthmap_m1_crop.tif \\
      --cutoff 0.005 --out data/crop_center_4096/depthmap_hf.tif
  uv run python scripts/convert_scan.py \\
      --src data/crop_center_4096 --albedo albedo_m1_crop.tif \\
      --channel height_hf=depthmap_hf.tif \\
      --channel height_full=depthmap_m1_crop.tif \\
      --factor 2 --name auer-moss-2048px \\
      --credit "Nature-printed moss, Alois Auer, \\"Der polygraphische Apparat\\", Vienna, 1853. From the private collection of Adam Lowe." \\
      --out data/sample
"""

import argparse
import json
import os

import numpy as np
import tifffile
from PIL import Image

Image.MAX_IMAGE_PIXELS = None          # full plate is ~192 MP

PIXEL_SIZE_M = 1.2300242130750606e-05  # from the .tfw world file


def normalize16(arr, clip_pct=0.0):
    """Normalise a float array to uint16 full range; return (png, range_mm).

    With clip_pct > 0 the range is taken between that percentile and its
    mirror (for example 0.5 and 99.5), and values outside are clamped.
    This protects the range from edge artefacts and dust spikes. Heights
    inside the clipped range still measure correctly in the viewer.
    """
    if clip_pct > 0:
        lo, hi = (float(v) for v in
                  np.percentile(arr, [clip_pct, 100.0 - clip_pct]))
        if hi <= lo:
            # Degenerate clip window (flat data): fall back to min and max
            lo, hi = float(arr.min()), float(arr.max())
        else:
            arr = np.clip(arr, lo, hi)
    else:
        lo, hi = float(arr.min()), float(arr.max())
    norm = ((arr - lo) / (hi - lo) * 65535).astype(np.uint16)
    return norm, (hi - lo) * 1000  # metres -> mm


def parse_channel(spec):
    if '=' not in spec:
        raise argparse.ArgumentTypeError(
            f'--channel must be NAME=FILE, got {spec!r}')
    name, _, filename = spec.partition('=')
    return name, filename


def main():
    p = argparse.ArgumentParser(
        description='Convert scanner output into a Tactum Viewer dataset.')
    p.add_argument('--src', required=True,
                    help='directory with the scan files')
    p.add_argument('--albedo', required=True,
                    help='uint16 RGB albedo TIFF filename inside --src')
    p.add_argument('--channel', action='append', required=True, default=[],
                    type=parse_channel, metavar='NAME=FILE',
                    help='height channel: NAME=FILE, where FILE is a '
                         'floating point depthmap TIFF in metres inside '
                         '--src. Repeatable. Order is preserved; the first '
                         'one is the default channel unless '
                         '--default-channel is given.')
    p.add_argument('--pixel-size', type=float, default=PIXEL_SIZE_M,
                    help='source pixel size in metres, from the .tfw '
                         'world file (default: %(default)s)')
    p.add_argument('--factor', type=int, default=1,
                    help='decimation factor (1 = full resolution)')
    p.add_argument('--name', default=None,
                    help='dataset name (default: dataset-<width>px)')
    p.add_argument('--default-channel', default=None,
                    help='which --channel NAME loads by default '
                         '(default: the first one given)')
    p.add_argument('--clip', type=float, default=0.0,
                    help='percentile clip before quantisation, for example '
                         '0.5. Protects the height range from edge '
                         'artefacts and dust spikes. 0 disables '
                         '(default: %(default)s)')
    p.add_argument('--credit', default=None,
                    help='attribution line, written to dataset.json '
                         '(omitted if not given)')
    p.add_argument('--out', required=True, help='output directory')
    args = p.parse_args()
    os.makedirs(args.out, exist_ok=True)
    factor = args.factor
    pixel_m = args.pixel_size * factor
    default_channel = args.default_channel or args.channel[0][0]

    height_channels = {}
    albedo_width = None
    for name, filename in args.channel:
        print(f'Reading {filename}...')
        depth = tifffile.imread(os.path.join(args.src, filename))[::factor, ::factor]
        depth = depth.astype(np.float64)
        img, range_mm = normalize16(depth, args.clip)
        out_name = f'{name}.png'
        Image.fromarray(img).save(os.path.join(args.out, out_name))
        albedo_width = img.shape[1]
        print(f'  {name}: {img.shape[1]}x{img.shape[0]}, '
              f'range {range_mm:.4f} mm')
        height_channels[name] = {'file': out_name,
                                  'heightRangeMM': round(range_mm, 6)}

    print(f'Reading {args.albedo}...')
    albedo = tifffile.imread(os.path.join(args.src, args.albedo))[::factor, ::factor]
    Image.fromarray((albedo >> 8).astype(np.uint8)).save(
        os.path.join(args.out, 'albedo.png'))

    dataset = {
        'name': args.name or f'dataset-{albedo_width}px',
        'pixelSizeMM': pixel_m * 1000,
        'albedo': 'albedo.png',
        'heightChannels': height_channels,
        'defaultHeightChannel': default_channel,
    }
    if args.credit:
        dataset['credit'] = args.credit
    with open(os.path.join(args.out, 'dataset.json'), 'w') as fh:
        json.dump(dataset, fh, indent=2)
    print(f'dataset.json written to {args.out}')


if __name__ == '__main__':
    main()
