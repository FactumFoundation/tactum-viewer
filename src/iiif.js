/**
 * IIIF manifest adapter: boots the viewer from a IIIF Presentation v3
 * manifest (ARCHiOx LightingMap extension + height channels) instead of a
 * local metadata.json.
 *
 * The internal metadata shape (quadtree canvas, zScale, dataRegion…) is
 * reconstructed from the manifest plus one info.json:
 *   - real image dims        → Canvas width/height
 *   - pixelSizeMM            → Physical Dimensions service on the Canvas
 *   - channels + physics     → LightingMapExtension service per Choice item
 *   - tileSize/maxLevel      → info.json tiles + scaleFactors
 *   - canvasSize             → tileSize · max(scaleFactors)
 */

const LIGHTINGMAP_TYPE = 'LightingMapExtension';

const UNITS_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };

/** IIIF Image API URL for a quadtree node: {x},{y},{w},{h}/{tw},{th}/0/default.png */
export function iiifTileUrl(serviceBase, node, { imageWidth, imageHeight, tileSize, maxLevel }) {
  const sf = 2 ** (maxLevel - node.level);
  const x = node.col * tileSize * sf;
  const y = node.row * tileSize * sf;
  const w = Math.min(tileSize * sf, imageWidth - x);
  const h = Math.min(tileSize * sf, imageHeight - y);
  const tw = Math.ceil(w / sf);
  const th = Math.ceil(h / sf);
  return `${serviceBase}/${x},${y},${w},${h}/${tw},${th}/0/default.png`;
}

function imageServiceOf(item) {
  const svc = (item.service || []).find(s => s.type === 'ImageService3');
  return svc ? { ...svc, id: svc.id ?? svc['@id'] } : undefined;
}

function lightingMapServiceOf(item) {
  return (item.service || []).find(s => s.type === LIGHTINGMAP_TYPE);
}

/** Pure parser: manifest JSON + one info.json → { metadata, services }. */
export function parseManifest(manifest, info) {
  const canvas = manifest.items[0];
  const W = canvas.width;
  const H = canvas.height;

  const physdim = (canvas.service || []).find(s => String(s.profile || '').includes('physdim'));
  const pixelSizeMM = physdim
    ? physdim.physicalScale * (UNITS_TO_MM[physdim.physicalUnits] ?? 1)
    : null;

  const body = canvas.items[0].items[0].body;
  const items = body.type === 'Choice' ? body.items : [body];

  const channels = [];
  const services = {};
  const heightFields = {};
  let defaultHeightChannel = null;

  for (const item of items) {
    const lm = lightingMapServiceOf(item);
    const img = imageServiceOf(item);
    if (!lm || !img) continue;

    let name;
    if (lm.mapType === 'height') {
      name = lm.variant ? `height_${lm.variant}` : 'height';
      heightFields[name] = { heightRangeMM: lm.heightRangeMM, zScale: lm.zScale };
      if (lm.default) defaultHeightChannel = name;
    } else {
      name = lm.mapType;
    }
    channels.push(name);
    services[name] = img.id;
  }
  if (!defaultHeightChannel) {
    defaultHeightChannel = Object.keys(heightFields)[0] ?? null;
  }

  const tileSize = info.tiles[0].width;
  const maxScale = Math.max(...info.tiles[0].scaleFactors);
  // extend beyond the listed scaleFactors if they don't cover the image in a
  // single root tile (dynamic services accept arbitrary regions; a level-0
  // static tree never needs this by construction)
  const needed = Math.ceil(Math.log2(Math.max(W, H) / tileSize));
  const maxLevel = Math.max(Math.round(Math.log2(maxScale)), needed);
  const canvasSize = tileSize * 2 ** maxLevel;

  const dflt = heightFields[defaultHeightChannel] ?? { heightRangeMM: 0, zScale: 0 };
  const metadata = {
    tileSize,
    canvasSize,
    maxLevel,
    imageWidth: W,
    imageHeight: H,
    pixelSizeMM,
    heightRangeMM: dflt.heightRangeMM,
    minValue: 0,
    maxValue: 65535,
    channels,
    worldWidth: 1.0,
    worldHeight: 1.0,
    dataRegion: {
      x: 0,
      z: 0,
      width: W / canvasSize,
      height: H / canvasSize,
    },
    zScale: dflt.zScale,
    defaultHeightChannel,
    heightFields,
  };

  return { metadata, services };
}

/** Fetch + parse a manifest; returns { metadata, services, tileUrlFor }. */
export async function loadIIIFDataset(manifestUrl) {
  const manifest = await fetch(manifestUrl).then(r => {
    if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
    return r.json();
  });

  const body = manifest.items[0].items[0].items[0].body;
  const first = body.type === 'Choice' ? body.items[0] : body;
  const firstService = imageServiceOf(first);
  if (!firstService) throw new Error('manifest has no ImageService3 service');

  const info = await fetch(`${firstService.id}/info.json`).then(r => {
    if (!r.ok) throw new Error(`info.json fetch failed: ${r.status}`);
    return r.json();
  });

  const { metadata, services } = parseManifest(manifest, info);
  const geom = {
    imageWidth: metadata.imageWidth,
    imageHeight: metadata.imageHeight,
    tileSize: metadata.tileSize,
    maxLevel: metadata.maxLevel,
  };
  const tileUrlFor = (channel, node) => iiifTileUrl(services[channel], node, geom);

  return { metadata, services, tileUrlFor };
}
