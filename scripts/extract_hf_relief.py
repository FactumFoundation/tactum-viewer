"""Derive a high pass relief channel from a raw depthmap.

For scanners that export a single depthmap. Selene PSS already exports
the surface with and without the low frequency warp, so with Selene data
this tool is not needed.

Reads a floating point depthmap in metres, subtracts a Gaussian low pass
version of itself, and writes the result as a float32 TIFF. The low pass
sigma is `--cutoff` converted to pixels using `--pixel-size`. A larger
cutoff removes more of the low frequency warp of the object and keeps
more of the fine relief.

Usage:
  uv run python scripts/extract_hf_relief.py \\
      --src path/to/depthmap.tif --cutoff 0.025 \\
      --out path/to/depthmap_hf.tif
"""

import argparse

import numpy as np
import tifffile
from scipy.ndimage import gaussian_filter, zoom

PIXEL_SIZE_M = 1.2300242130750606e-05  # from the .tfw world file

# Above this sigma the low pass runs on a reduced copy of the image.
# A direct convolution with a very large kernel takes hours; estimating
# the low frequency surface at reduced resolution and scaling it back up
# gives the same result in seconds.
PYRAMID_SIGMA = 32.0


def lowpass(depth, sigma_px):
    """Gaussian low pass, computed at reduced resolution when sigma is large."""
    if sigma_px <= PYRAMID_SIGMA:
        return gaussian_filter(depth, sigma=sigma_px, mode='reflect')
    step = int(sigma_px / (PYRAMID_SIGMA / 2))
    small = gaussian_filter(depth[::step, ::step],
                            sigma=sigma_px / step, mode='reflect')
    up = zoom(small, step, order=1, mode='nearest', grid_mode=True)
    return up[:depth.shape[0], :depth.shape[1]]


def main():
    p = argparse.ArgumentParser(
        description='Derive a high pass relief channel from a depthmap.')
    p.add_argument('--src', required=True, help='depthmap TIFF (float, metres)')
    p.add_argument('--pixel-size', type=float, default=PIXEL_SIZE_M,
                    help='source pixel size in metres, from the .tfw '
                         'world file (default: %(default)s)')
    p.add_argument('--cutoff', type=float, required=True,
                    help='high pass cutoff in metres, a little above the '
                         'scale of the relief detail you care about '
                         '(0.005 works well for printing plates and paper)')
    p.add_argument('--out', required=True, help='output TIFF path')
    args = p.parse_args()

    print(f'Reading {args.src}...')
    depth = tifffile.imread(args.src).astype(np.float64)
    print(f'  input range: {(depth.max() - depth.min()) * 1000:.4f} mm')

    sigma_px = args.cutoff / args.pixel_size
    relief = depth - lowpass(depth, sigma_px)
    print(f'  sigma: {sigma_px:.1f} px'
          + (' (reduced resolution low pass)' if sigma_px > PYRAMID_SIGMA else ''))
    print(f'  output range: {(relief.max() - relief.min()) * 1000:.4f} mm')

    tifffile.imwrite(args.out, relief.astype(np.float32),
                      compression='zlib', predictor=3)
    print(f'written to {args.out}')


if __name__ == '__main__':
    main()
