import { describe, it, expect } from 'vitest';
import { formatDistanceMM, planarDistanceMM, chord3DMM, measurementLabel, segmentSamples, buildProfilePath } from '../src/MeasureTool.js';

describe('formatDistanceMM', () => {
  it('uses mm with one decimal below 100 mm', () => {
    expect(formatDistanceMM(12.44)).toBe('12.4 mm');
    expect(formatDistanceMM(0.27)).toBe('0.3 mm');
  });

  it('switches to cm with two decimals from 100 mm', () => {
    expect(formatDistanceMM(100)).toBe('10.00 cm');
    expect(formatDistanceMM(321.4)).toBe('32.14 cm');
  });
});

describe('planarDistanceMM', () => {
  it('measures XZ distance scaled to mm', () => {
    const a = { x: 0, z: 0 }, b = { x: 3, z: 4 };
    expect(planarDistanceMM(a, b, 10)).toBe(50);
  });

  it('ignores Y (in-plane by definition)', () => {
    const a = { x: 0, y: 9, z: 0 }, b = { x: 1, y: -4, z: 0 };
    expect(planarDistanceMM(a, b, 403.2)).toBeCloseTo(403.2);
  });
});

describe('chord3DMM', () => {
  it('is the hypotenuse of planar and elevation deltas', () => {
    expect(chord3DMM(3, 4)).toBe(5);
    expect(chord3DMM(10, 0)).toBe(10);
  });
});

describe('measurementLabel', () => {
  it('composes 3D distance with elevation delta', () => {
    expect(measurementLabel(3, 4)).toBe('5.0 mm · Δh 4.0 mm');
  });
  it('falls back to planar-only when Δh is unknown', () => {
    expect(measurementLabel(12.44, null)).toBe('12.4 mm');
  });
  it('keeps cm switching for the primary distance', () => {
    expect(measurementLabel(320, 15)).toBe('32.04 cm · Δh 15.0 mm');
  });
});

describe('segmentSamples', () => {
  it('interpolates n+1 points from a to b inclusive', () => {
    const s = segmentSamples({ x: 0, z: 0 }, { x: 10, z: 20 }, 2);
    expect(s).toEqual([
      { x: 0, z: 0, t: 0 },
      { x: 5, z: 10, t: 0.5 },
      { x: 10, z: 20, t: 1 },
    ]);
  });
});

describe('buildProfilePath', () => {
  it('maps norms to pixel space, min at bottom, max at top', () => {
    const { segments, minMM, maxMM } = buildProfilePath([0, 0.5, 1], 2, 100, 50, 0);
    expect(minMM).toBe(0);
    expect(maxMM).toBe(2);
    expect(segments).toEqual([[
      { px: 0, py: 50 },
      { px: 50, py: 25 },
      { px: 100, py: 0 },
    ]]);
  });

  it('splits segments on null samples and ignores them for the range', () => {
    const { segments, minMM, maxMM } = buildProfilePath([0.5, null, 0.5, 1], 4, 90, 30, 0);
    expect(minMM).toBe(2);
    expect(maxMM).toBe(4);
    expect(segments.length).toBe(2);
    expect(segments[0]).toEqual([{ px: 0, py: 30 }]);
    expect(segments[1]).toEqual([{ px: 60, py: 30 }, { px: 90, py: 0 }]);
  });

  it('centres a flat profile instead of dividing by zero', () => {
    const { segments } = buildProfilePath([0.5, 0.5], 1, 100, 40, 0);
    expect(segments[0].every(p => p.py === 20)).toBe(true);
  });
});
