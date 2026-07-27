import * as THREE from 'three';

const DEFAULT_MAX_LEVEL = 14;
const SIM_EXTENT = 20000; // the quadtree simulates a 20k×20k texture space

// ---------------------------------------------------------------------------
// QuadTreeNode: one cell of the quadtree
// ---------------------------------------------------------------------------
export class QuadTreeNode {
  /**
   * @param {number} cx    centre X in world coords (range -0.5 … 0.5)
   * @param {number} cz    centre Z in world coords
   * @param {number} half  half-size in world units (full tile = half × 2)
   * @param {number} level depth in the tree (0 = root)
   */
  constructor(cx, cz, half, level = 0, maxLevel = DEFAULT_MAX_LEVEL) {
    this.cx = cx;
    this.cz = cz;
    this.half = half;
    this.level = level;
    this._maxLevel = maxLevel;
    this.children = null;

    // Map world coords → simulated 20k×20k pixel coords (for tile labels)
    this.simX = Math.round((cx - half + 0.5) * SIM_EXTENT);
    this.simZ = Math.round((cz - half + 0.5) * SIM_EXTENT);
    this.simSize = Math.round(half * 2 * SIM_EXTENT);

    this._sse = 0; // computed each frame by QuadTree.update()
  }

  get isLeaf() { return this.children === null; }

  // Size of the tile in world units. Halves with each subdivision level.
  // This IS the geometric error: a bigger tile covers more area with the
  // same texture resolution, so it "loses" more detail.
  get geometricError() { return this.half * 2; }

  // Deterministic key for the mesh pool: same level+position → same key.
  // Safe because all coordinates are fractions of powers of 2 (exact in float).
  get key() { return `${this.level}:${this.cx}:${this.cz}`; }

  // Integer tile coordinates for the TMS tile pyramid (tiles/{z}/{col}/{row}.png)
  get col() { return Math.round((this.cx - this.half + 0.5) / (this.half * 2)); }
  get row() { return Math.round((this.cz - this.half + 0.5) / (this.half * 2)); }

  split() {
    if (!this.isLeaf || this.level >= this._maxLevel) return false;
    const h = this.half / 2;
    const l = this.level + 1;
    this.children = [
      new QuadTreeNode(this.cx - h, this.cz - h, h, l, this._maxLevel),
      new QuadTreeNode(this.cx + h, this.cz - h, h, l, this._maxLevel),
      new QuadTreeNode(this.cx - h, this.cz + h, h, l, this._maxLevel),
      new QuadTreeNode(this.cx + h, this.cz + h, h, l, this._maxLevel),
    ];
    return true;
  }
}

// ---------------------------------------------------------------------------
// QuadTree: rebuilt from scratch each frame via priority split
//
// Why rebuild instead of incremental split/merge?
// The incremental approach caused the tile budget to "freeze" in a fixed
// distribution that didn't respond to camera movement.
// ---------------------------------------------------------------------------
export class QuadTree {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxLevel=14] deepest allowed subdivision level
   */
  constructor({ maxLevel = DEFAULT_MAX_LEVEL, clipRegion = null } = {}) {
    this._maxLevel = maxLevel;
    this._clipRegion = clipRegion; // {minX, maxX, minZ, maxZ} or null
    this.root = null;
    this.leaves = [];
    this.totalNodes = 0;
    this.maxLevel = 0;
    this.minLeafSSE = 0;
    this.maxLeafSSE = 0;

    this._v3 = new THREE.Vector3(); // reused to avoid allocations in _sse()
  }

  /**
   * Rebuild the tree for the current camera.
   *
   * Algorithm: start with root, repeatedly split the leaf with the highest
   * SSE until the tile budget runs out or no leaf exceeds the threshold.
   * This guarantees optimal budget allocation regardless of camera position.
   */
  update(camera, screenH, maxSSE, maxTiles, splitFloorRatio = 0) {
    this.root = new QuadTreeNode(0, 0, 0.5, 0, this._maxLevel);
    this.root._sse = this._sse(this.root, camera, screenH);

    const candidates = [this.root]; // leaves that may still need splitting
    let leafCount = 1;

    while (candidates.length > 0 && leafCount + 3 <= maxTiles) {
      // Find candidate with highest SSE (linear scan, fine for ≤400 items)
      let bestIdx = 0;
      for (let i = 1; i < candidates.length; i++) {
        if (candidates[i]._sse > candidates[bestIdx]._sse) bestIdx = i;
      }

      const node = candidates[bestIdx];
      if (node._sse <= maxSSE || node.level >= this._maxLevel) break;

      // Skip subdivision if a child would fall below the split floor.
      // The floor is RELATIVE to maxSSE (splitFloorRatio ∈ [0,1]), so it
      // auto-scales with the quality target and never overrides maxSSE.
      // SSE === screen size here (geometricError === tileSize); children are
      // half the parent's size, so a child's SSE is node._sse / 2.
      // ratio 0.5 → guard coincides with maxSSE (neutral); →1.0 widens the
      // dead band to one octave (conservative).
      if (splitFloorRatio > 0 && node._sse / 2 < maxSSE * splitFloorRatio) {
        candidates[bestIdx] = candidates[candidates.length - 1];
        candidates.pop();
        continue;
      }

      // Remove from candidates: swap with last element for O(1) removal
      candidates[bestIdx] = candidates[candidates.length - 1];
      candidates.pop();

      // Split: 1 leaf becomes 4 children → net +3 leaves
      node.split();
      leafCount += 3;

      for (const c of node.children) {
        c._sse = this._sse(c, camera, screenH);
        if (c._sse > maxSSE && c.level < this._maxLevel && this._intersectsClip(c)) {
          candidates.push(c);
        }
      }
    }

    // Collect all leaves for the TileRenderer
    this.leaves = [];
    this.totalNodes = 0;
    this.maxLevel = 0;
    this._collect(this.root);

    let mn = Infinity, mx = -Infinity;
    for (const l of this.leaves) {
      if (l._sse < mn) mn = l._sse;
      if (l._sse > mx) mx = l._sse;
    }
    this.minLeafSSE = mn;
    this.maxLeafSSE = mx;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Check if a node's AABB intersects the clip region (if set). */
  _intersectsClip(node) {
    if (!this._clipRegion) return true;
    const cr = this._clipRegion;
    return (node.cx + node.half > cr.minX && node.cx - node.half < cr.maxX &&
            node.cz + node.half > cr.minZ && node.cz - node.half < cr.maxZ);
  }

  /** Recursively collect leaves and stats. */
  _collect(node) {
    this.totalNodes++;
    if (node.isLeaf) {
      if (this._intersectsClip(node)) {
        this.leaves.push(node);
        if (node.level > this.maxLevel) this.maxLevel = node.level;
      }
      return;
    }
    for (const c of node.children) this._collect(c);
  }

  /**
   * Screen-Space Error: project the node's geometric error to screen pixels.
   *
   * Uses the closest point on the tile's AABB (not the centre) to get
   * the distance. This is more accurate for large tiles where the centre
   * may be far but an edge is near.
   *
   * Formula (perspective):
   *   SSE = geometricError × screenHeight / (2 × distance × tan(fov/2))
   */
  _sse(node, camera, screenH) {
    // Tile AABB bounds (Y is always 0, flat surface)
    const minX = node.cx - node.half;
    const maxX = node.cx + node.half;
    const minZ = node.cz - node.half;
    const maxZ = node.cz + node.half;

    // Closest point on AABB to camera (clamp camera pos to tile bounds)
    const cp = camera.position;
    this._v3.set(
      Math.max(minX, Math.min(cp.x, maxX)),
      0,
      Math.max(minZ, Math.min(cp.z, maxZ)),
    );

    const dist = Math.max(cp.distanceTo(this._v3), 0.0001);
    const geo  = node.geometricError;

    if (camera.isPerspectiveCamera) {
      const fovRad = THREE.MathUtils.degToRad(camera.fov);
      return (geo * screenH) / (2 * dist * Math.tan(fovRad / 2));
    }
    // Orthographic: no perspective, SSE depends on visible range
    return (geo / (camera.top - camera.bottom)) * screenH;
  }
}
