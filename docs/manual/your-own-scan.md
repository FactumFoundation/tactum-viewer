# Using your own scan

The pipeline starts from the raw output of a surface scanner: a floating
point depthmap in metres (32 or 64 bit TIFF) and a colour image of the
same size. Everything else is derived from those two files.

## 1. Convert the scan

Selene PSS exports the surface twice, with and without the low frequency
warp of the object, so both go in as separate height channels:

```bash
uv run python scripts/convert_scan.py \
    --src path/to/your_scan --albedo albedo.tif \
    --channel height_hf=depthmap_hf.tif --channel height_full=depthmap.tif \
    --pixel-size 1.23e-05 --out data/your_dataset
```

Two values matter here:

- `--pixel-size` is the size of one pixel in metres. Scanners usually
  write it in a `.tfw` world file next to the TIFF.
- `--factor` decimates the input if you want a lighter dataset. Use 1 to
  keep the full resolution.

If your scanner exports a single depthmap instead of two, derive the
filtered relief channel yourself first:

```bash
uv run python scripts/extract_hf_relief.py \
    --src path/to/your_scan/depth.tif \
    --cutoff 0.005 --out path/to/your_scan/depthmap_hf.tif
```

`--cutoff` controls the high pass filter that separates the fine relief
from the overall warp of the object. Pick it a little above the scale of
the relief detail you care about. For printing plates and paper 5 mm
works well. Too large and the warp stays in the relief channel. Too
small and real features start to disappear.

The converter writes a dataset directory: a 16 bit height PNG per
channel, an 8 bit albedo PNG, and a `dataset.json` manifest with the
physical values the viewer needs. The 16 bit files are an intermediate
format. The precision of your raw depthmap is used during the
conversion, when each channel is scaled to its own height range. The
converter only scales and quantises the data, it does not filter it.

The converter does not write an `info.json` file. If you want the plaque
panel in the viewer to describe your piece, create `info.json` by hand
next to the tiles, with the fields `title`, `author`, `date`,
`technique`, `collection`, `scanner` and `description`.

## 2. Generate tiles

```bash
uv run python scripts/generate_tiles.py --src data/your_dataset --out public/your_dataset
```

This writes the tile pyramid and a `metadata.json` manifest, which is what
the viewer loads at runtime.

## 3. Point the viewer at it

Edit the two `'../moss/'` paths near the top of `demo/main.js`, or skip
the editing and load it through a IIIF manifest with `?manifest=`, as
described in the [IIIF chapter](iiif.md).
