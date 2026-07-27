import { describe, it, expect } from 'vitest';
import { parseManifest, iiifTileUrl } from '../src/iiif.js';

const BASE = 'https://example.org/iiif/blake';

// mirrors the output of scripts/generate_iiif_manifest.py for the Blake dataset
const MANIFEST = {
  '@context': [
    'https://iiif.bodleian.ox.ac.uk/contexts/lightingmap/context.json',
    'http://iiif.io/api/presentation/3/context.json',
  ],
  id: `${BASE}/manifest.json`,
  type: 'Manifest',
  label: { en: ['Test plate'] },
  items: [{
    id: `${BASE}/canvas/1`,
    type: 'Canvas',
    width: 7597,
    height: 9674,
    service: [{
      '@context': 'http://iiif.io/api/annex/services/physdim/1/context.json',
      '@id': `${BASE}/physdim`,
      '@type': 'PhysicalDimensionsService',
      profile: 'http://iiif.io/api/annex/services/physdim',
      physicalScale: 0.023872,
      physicalUnits: 'mm',
    }],
    items: [{
      id: `${BASE}/canvas/1/page/1`,
      type: 'AnnotationPage',
      items: [{
        id: `${BASE}/canvas/1/page/1/anno/1`,
        type: 'Annotation',
        motivation: 'painting',
        target: `${BASE}/canvas/1`,
        body: {
          type: 'Choice',
          items: [
            {
              id: `${BASE}/albedo/full/950,1210/0/default.png`,
              type: 'Image', format: 'image/png',
              label: { en: ['Albedo'] }, width: 7597, height: 9674,
              service: [
                { id: `${BASE}/albedo`, type: 'ImageService3', profile: 'level0' },
                { id: `${BASE}/albedo`, type: 'LightingMapExtension',
                  profile: 'http://iiif.io/api/extension/lightingmap', mapType: 'albedo' },
              ],
            },
            {
              id: `${BASE}/height_hf/full/950,1210/0/default.png`,
              type: 'Image', format: 'image/png',
              label: { en: ['Height - HF'] }, width: 7597, height: 9674,
              service: [
                { id: `${BASE}/height_hf`, type: 'ImageService3', profile: 'level0' },
                { id: `${BASE}/height_hf`, type: 'LightingMapExtension',
                  profile: 'http://iiif.io/api/extension/lightingmap',
                  mapType: 'height', variant: 'hf', default: true,
                  heightRangeMM: 1.207934, zScale: 0.0030884059087314735,
                  heightEncoding: { format: 'rg16' } },
              ],
            },
            {
              id: `${BASE}/height_full/full/950,1210/0/default.png`,
              type: 'Image', format: 'image/png',
              label: { en: ['Height - FULL'] }, width: 7597, height: 9674,
              service: [
                { id: `${BASE}/height_full`, type: 'ImageService3', profile: 'level0' },
                { id: `${BASE}/height_full`, type: 'LightingMapExtension',
                  profile: 'http://iiif.io/api/extension/lightingmap',
                  mapType: 'height', variant: 'full',
                  heightRangeMM: 29.135071, zScale: 0.0744916050202127,
                  heightEncoding: { format: 'rg16' } },
              ],
            },
          ],
        },
      }],
    }],
  }],
};

const INFO = {
  '@context': 'http://iiif.io/api/image/3/context.json',
  id: `${BASE}/albedo`,
  type: 'ImageService3',
  protocol: 'http://iiif.io/api/image',
  profile: 'level0',
  width: 7597,
  height: 9674,
  maxWidth: 950,
  maxHeight: 1210,
  tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8, 16, 32, 64] }],
  sizes: [{ width: 119, height: 152 }],
  preferredFormats: ['png'],
};

describe('parseManifest', () => {
  const { metadata, services } = parseManifest(MANIFEST, INFO);

  it('reconstructs the quadtree canvas geometry from info.json', () => {
    expect(metadata.tileSize).toBe(256);
    expect(metadata.maxLevel).toBe(6);
    expect(metadata.canvasSize).toBe(16384);
  });

  it('recovers real image dims and data region', () => {
    expect(metadata.imageWidth).toBe(7597);
    expect(metadata.imageHeight).toBe(9674);
    expect(metadata.dataRegion.width).toBeCloseTo(7597 / 16384, 10);
    expect(metadata.dataRegion.height).toBeCloseTo(9674 / 16384, 10);
  });

  it('recovers pixel size from the physdim service', () => {
    expect(metadata.pixelSizeMM).toBeCloseTo(0.023872, 9);
  });

  it('recovers channels, height fields and the default', () => {
    expect(metadata.channels).toEqual(['albedo', 'height_hf', 'height_full']);
    expect(metadata.defaultHeightChannel).toBe('height_hf');
    expect(metadata.heightFields.height_hf.heightRangeMM).toBeCloseTo(1.207934);
    expect(metadata.heightFields.height_full.zScale).toBeCloseTo(0.0744916050202127);
    expect(metadata.zScale).toBeCloseTo(0.0030884059087314735);
  });

  it('maps channels to their image service bases', () => {
    expect(services.albedo).toBe(`${BASE}/albedo`);
    expect(services.height_full).toBe(`${BASE}/height_full`);
  });

  it('converts physdim units to mm', () => {
    const m = structuredClone(MANIFEST);
    m.items[0].service[0].physicalScale = 0.0000238719560906382;
    m.items[0].service[0].physicalUnits = 'm';
    const { metadata: md } = parseManifest(m, INFO);
    expect(md.pixelSizeMM).toBeCloseTo(0.0238719560906382, 12);
  });
});

describe('parseManifest without height channels (ARCHiOx-style degradation)', () => {
  const m = structuredClone(MANIFEST);
  m.items[0].items[0].items[0].body.items =
    m.items[0].items[0].items[0].body.items.filter(
      i => i.service[1].mapType !== 'height',
    );
  const { metadata } = parseManifest(m, INFO);

  it('yields a flat dataset instead of crashing', () => {
    expect(metadata.defaultHeightChannel).toBeNull();
    expect(metadata.zScale).toBe(0);
    expect(metadata.heightRangeMM).toBe(0);
    expect(metadata.channels).toEqual(['albedo']);
  });
});

describe('iiifTileUrl', () => {
  const geom = { imageWidth: 7597, imageHeight: 9674, tileSize: 256, maxLevel: 6 };

  it('interior tile: full region, 256px canonical size', () => {
    const node = { level: 6, col: 3, row: 4 };
    expect(iiifTileUrl(`${BASE}/albedo`, node, geom))
      .toBe(`${BASE}/albedo/768,1024,256,256/256,256/0/default.png`);
  });

  it('edge tile: region and size cropped to image bounds', () => {
    // level 6, sf=1: last column starts at 29*256 = 7424, remaining = 173
    const node = { level: 6, col: 29, row: 0 };
    expect(iiifTileUrl(`${BASE}/albedo`, node, geom))
      .toBe(`${BASE}/albedo/7424,0,173,256/173,256/0/default.png`);
  });

  it('root tile: whole image at scaleFactor 64', () => {
    const node = { level: 0, col: 0, row: 0 };
    expect(iiifTileUrl(`${BASE}/albedo`, node, geom))
      .toBe(`${BASE}/albedo/0,0,7597,9674/119,152/0/default.png`);
  });
});
