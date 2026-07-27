import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { QuadTree } from '../src/QuadTree.js';

// An overhead perspective camera looking down at the unit surface.
// maxTiles is high enough (8000) that the tile budget never caps the tree,
// so maxSSE and the split floor, not the budget, determine the leaf count.
// That is what makes the effects below observable.
function makeCamera() {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.001, 100);
  cam.position.set(0, 0.8, 0.001);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}

describe('QuadTree SSE-driven LOD', () => {
  it('lowering maxSSE increases the leaf count', () => {
    const qt = new QuadTree({ maxLevel: 7 });
    const cam = makeCamera();

    qt.update(cam, 1000, 60, 8000, 0.5);
    const coarse = qt.leaves.length;

    qt.update(cam, 1000, 20, 8000, 0.5);
    const fine = qt.leaves.length;

    expect(fine).toBeGreaterThan(coarse);
  });
});

describe('QuadTree relative split floor', () => {
  it('a higher splitFloorRatio yields fewer leaves at the same maxSSE', () => {
    const qt = new QuadTree({ maxLevel: 7 });
    const cam = makeCamera();

    qt.update(cam, 1000, 20, 8000, 0.5); // neutral floor
    const neutral = qt.leaves.length;

    qt.update(cam, 1000, 20, 8000, 1.0); // conservative one-octave dead band
    const conservative = qt.leaves.length;

    expect(conservative).toBeLessThan(neutral);
  });
});
