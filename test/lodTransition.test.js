import { describe, it, expect } from 'vitest';
import { tilesOverlap, isPresentable, canRetire } from '../src/lodTransition.js';

// A parent tile at the origin and its four quadtree children
const parent = { cx: 0, cz: 0, half: 0.25 };
const children = [
  { cx: -0.125, cz: -0.125, half: 0.125 },
  { cx:  0.125, cz: -0.125, half: 0.125 },
  { cx: -0.125, cz:  0.125, half: 0.125 },
  { cx:  0.125, cz:  0.125, half: 0.125 },
];

describe('tilesOverlap', () => {
  it('parent overlaps each of its children', () => {
    for (const c of children) expect(tilesOverlap(parent, c)).toBe(true);
  });

  it('edge-adjacent tiles do not overlap', () => {
    const a = { cx: 0, cz: 0, half: 0.125 };
    const b = { cx: 0.25, cz: 0, half: 0.125 }; // shares an edge with a
    expect(tilesOverlap(a, b)).toBe(false);
  });

  it('disjoint tiles do not overlap', () => {
    expect(tilesOverlap(parent, { cx: 10, cz: 10, half: 0.25 })).toBe(false);
  });
});

describe('isPresentable', () => {
  it('is false while textures are loading', () => {
    expect(isPresentable({ ready: false, readyAt: 0 }, 1000, 250)).toBe(false);
  });

  it('is false while the fade is still running', () => {
    expect(isPresentable({ ready: true, readyAt: 900 }, 1000, 250)).toBe(false);
  });

  it('is true once ready and fully faded in', () => {
    expect(isPresentable({ ready: true, readyAt: 700 }, 1000, 250)).toBe(true);
  });

  it('is true immediately when fade is disabled (fadeMs 0)', () => {
    expect(isPresentable({ ready: true, readyAt: 1000 }, 1000, 0)).toBe(true);
  });

  it('failed tiles count as presentable so they never block retirement', () => {
    expect(isPresentable({ failed: true, ready: false, readyAt: 0 }, 1000, 250)).toBe(true);
  });
});

describe('canRetire', () => {
  const presentable = (t) => ({ ...t, presentable: true });
  const pending = (t) => ({ ...t, presentable: false });

  it('parent retires when all four children are presentable', () => {
    expect(canRetire(parent, children.map(presentable))).toBe(true);
  });

  it('parent stays while any overlapping child is pending', () => {
    const wanted = [pending(children[0]), ...children.slice(1).map(presentable)];
    expect(canRetire(parent, wanted)).toBe(false);
  });

  it('pending tiles elsewhere do not block retirement', () => {
    const far = pending({ cx: 10, cz: 10, half: 0.25 });
    expect(canRetire(parent, [...children.map(presentable), far])).toBe(true);
  });

  it('retires vacuously when nothing overlaps it (clip region)', () => {
    expect(canRetire(parent, [])).toBe(true);
  });

  it('child retires when the parent covering it is presentable (merge)', () => {
    expect(canRetire(children[0], [presentable(parent)])).toBe(true);
  });
});
