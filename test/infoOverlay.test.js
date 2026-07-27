import { describe, it, expect } from 'vitest';
import { physicalDimensionsMM, scannerLine } from '../src/InfoOverlay.js';

describe('physicalDimensionsMM', () => {
  it('formats width × height in mm from pixel metadata', () => {
    expect(physicalDimensionsMM({ imageWidth: 7597, imageHeight: 9674, pixelSizeMM: 0.023872 }))
      .toBe('181.4 × 230.9 mm');
  });
  it('returns null without a physical pixel size', () => {
    expect(physicalDimensionsMM({ imageWidth: 100, imageHeight: 100 })).toBe(null);
  });
});

describe('scannerLine', () => {
  it('includes the scanner name when info.json provides one', () => {
    expect(scannerLine({ scanner: 'Selene PSS' }, { pixelSizeMM: 0.023872 }))
      .toBe('Selene PSS · 23.9 µm/px');
  });
  it('falls back to just the pixel size when there is no scanner field', () => {
    expect(scannerLine({}, { pixelSizeMM: 0.023872 })).toBe('23.9 µm/px');
  });
  it('returns null without a physical pixel size', () => {
    expect(scannerLine({ scanner: 'Selene PSS' }, {})).toBe(null);
  });
});
