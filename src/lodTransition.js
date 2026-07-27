/**
 * Pure decision logic for coverage-based tile retirement.
 * No Three.js dependencies.
 */

/** Do two tiles ({cx, cz, half}) overlap? Shared edges do not count. */
export function tilesOverlap(a, b) {
  return Math.abs(a.cx - b.cx) < a.half + b.half &&
         Math.abs(a.cz - b.cz) < a.half + b.half;
}

/**
 * Is a tile safe to draw over what it replaces, i.e. loaded and fully
 * faded in? Failed tiles count as presentable: they will never load and
 * must not block retirement of the tiles beneath them.
 *
 * @param {{failed?: boolean, ready: boolean, readyAt: number}} entry
 * @param {number} now     current timestamp in ms
 * @param {number} fadeMs  effective fade duration (0 when fade is disabled)
 */
export function isPresentable(entry, now, fadeMs) {
  if (entry.failed) return true;
  return entry.ready && now - entry.readyAt >= fadeMs;
}

/**
 * May a retiring tile be disposed? True when every wanted tile overlapping
 * its footprint is presentable. Quadtree leaves tessellate the plane, so
 * this implies the retiring tile's area is fully covered by real content.
 *
 * @param {{cx: number, cz: number, half: number}} tile
 * @param {Array<{cx: number, cz: number, half: number, presentable: boolean}>} wanted
 */
export function canRetire(tile, wanted) {
  for (const w of wanted) {
    if (!w.presentable && tilesOverlap(tile, w)) return false;
  }
  return true;
}
