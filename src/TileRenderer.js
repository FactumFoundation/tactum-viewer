import * as THREE from 'three';

const TEX_RES = 256; // resolution of each tile's procedural texture

// Viridis-inspired palette: one colour per level so LOD changes are obvious
const PALETTE = [
  [ 68,   1,  84], // 0  deep purple
  [ 72,  35, 116], // 1  purple
  [ 64,  67, 135], // 2  indigo
  [ 52,  94, 141], // 3  blue
  [ 33, 145, 140], // 4  teal
  [ 53, 183, 121], // 5  green
  [109, 205,  89], // 6  lime
  [180, 222,  44], // 7  yellow-green
  [253, 231,  37], // 8  yellow
  [ 68,   1,  84], // 9  (cycle)
  [ 64,  67, 135], // 10
  [ 33, 145, 140], // 11
  [109, 205,  89], // 12
];

// ---------------------------------------------------------------------------
// TileRenderer: manages Three.js meshes for visible quadtree leaves
//
// Supports two modes:
//   - Procedural: Canvas 2D textures (immediate, used as placeholder)
//   - Streaming:  loads tiles from /tiles/{z}/{col}/{row}.png via HTTP
//
// On startup, tries to fetch level-0 tile. If it exists, streaming is
// enabled and procedural textures serve as placeholders while tiles load.
// If it doesn't exist, procedural mode is used exclusively.
// ---------------------------------------------------------------------------
export class TileRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   * @param {boolean} [opts.streaming=true] try to load tiles from /tiles/{z}/{col}/{row}.png
   */
  constructor(scene, { streaming = true, tileBaseUrl = '../../tiles' } = {}) {
    this.scene = scene;
    this.pool = new Map();           // key → { mesh, wire, tex, mat, born, streamed }
    this.geoCache = new Map();       // halfSize → PlaneGeometry  (shared)
    this.edgeCache = new Map();      // halfSize → EdgesGeometry  (shared)

    // Streaming state
    this._streamingEnabled = streaming;
    this._streaming = streaming ? null : false; // null = not checked yet, false = disabled
    this._tileBaseUrl = tileBaseUrl;
    this._texCache = new Map();      // url → THREE.Texture (persists across pool changes)
    this._inflight = new Set();      // urls currently being fetched
    this._loader = new THREE.TextureLoader();
    this._loaded = 0;                // counter for HUD

    // Debug wireframe layer (all wires in one group for easy toggle)
    this.wireGroup = new THREE.Group();
    this.wireGroup.name = 'debug-wires';
    scene.add(this.wireGroup);

    this.wireMat = new THREE.LineBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.4,
      depthTest: false,
    });

    this._fadeMs = 180; // fade-in duration in ms
  }

  setFadeEnabled(on) {
    this._fadeMs = on ? 180 : 0;
    if (on) {
      const now = performance.now();
      for (const e of this.pool.values()) e.born = now;
    }
  }

  // ── geometry caches (one geometry per unique tile size) ─────────────────

  _geo(half) {
    const k = half.toFixed(8);
    if (!this.geoCache.has(k)) {
      const g = new THREE.PlaneGeometry(half * 2, half * 2);
      g.rotateX(-Math.PI / 2); // lay flat on XZ plane
      this.geoCache.set(k, g);
    }
    return this.geoCache.get(k);
  }

  _edges(half) {
    const k = half.toFixed(8);
    if (!this.edgeCache.has(k)) {
      this.edgeCache.set(k, new THREE.EdgesGeometry(this._geo(half)));
    }
    return this.edgeCache.get(k);
  }

  // ── procedural placeholder texture (Canvas 2D) ─────────────────────────

  _createPlaceholder(node) {
    const c = document.createElement('canvas');
    c.width = TEX_RES; c.height = TEX_RES;
    const ctx = c.getContext('2d');
    const r = TEX_RES;

    // Background colour based on level
    const [cr, cg, cb] = PALETTE[node.level % PALETTE.length];
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(0, 0, r, r);

    // Coarse grid (8×8)
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    const step = r / 8;
    for (let i = 1; i < 8; i++) {
      const p = i * step;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, r); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(r, p); ctx.stroke();
    }

    // Fine sub-grid (32×32)
    ctx.strokeStyle = 'rgba(0,0,0,0.04)';
    const sub = step / 4;
    for (let i = 1; i < 32; i++) {
      if (i % 4 === 0) continue; // skip lines that overlap the coarse grid
      const p = i * sub;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, r); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(r, p); ctx.stroke();
    }

    // Border
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, r - 3, r - 3);

    // Level label
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${r / 6}px monospace`;
    ctx.fillText(`L${node.level}`, r / 2, r / 2 - 22);

    // Simulated 20k×20k coordinates and tile size
    ctx.font = `${r / 12}px monospace`;
    ctx.fillText(`${node.simX}, ${node.simZ}`, r / 2, r / 2 + 8);
    ctx.fillText(`${node.simSize}\u00d7${node.simSize}`, r / 2, r / 2 + 30);

    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  // ── tile streaming ─────────────────────────────────────────────────────

  _tileUrl(node) {
    return `${this._tileBaseUrl}/${node.level}/${node.col}/${node.row}.png`;
  }

  /**
   * Start async load of a tile from the server.
   * If the texture is already cached, applies it immediately.
   * On first 404, disables streaming for all future requests.
   */
  _requestTile(node, key) {
    const url = this._tileUrl(node);

    // Already cached → apply immediately
    if (this._texCache.has(url)) {
      this._applyStreamed(key, this._texCache.get(url));
      return;
    }

    // Already in-flight → skip
    if (this._inflight.has(url)) return;
    this._inflight.add(url);

    this._loader.loadAsync(url)
      .then(tex => {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        this._texCache.set(url, tex);
        this._inflight.delete(url);
        this._loaded++;
        if (this._streaming === null) this._streaming = true;
        this._applyStreamed(key, tex);
      })
      .catch(() => {
        this._inflight.delete(url);
        // First failure → disable streaming (tiles not generated)
        if (this._streaming === null) this._streaming = false;
      });
  }

  /** Swap the placeholder texture for the streamed one. */
  _applyStreamed(key, tex) {
    const entry = this.pool.get(key);
    if (!entry) return; // tile was removed while loading

    if (!entry.streamed) {
      entry.tex.dispose(); // dispose procedural placeholder
    }
    entry.mat.map = tex;
    entry.mat.needsUpdate = true;
    entry.tex = tex;
    entry.streamed = true;
  }

  // ── per-frame sync with quadtree leaves ────────────────────────────────

  update(leaves, showWires) {
    const wantedKeys = new Set();
    const now = performance.now();

    // Ensure every visible leaf has a mesh
    for (const node of leaves) {
      const k = node.key;
      wantedKeys.add(k);

      if (!this.pool.has(k)) {
        const tex = this._createPlaceholder(node);
        const mat = new THREE.MeshBasicMaterial({
          map: tex, side: THREE.DoubleSide,
          transparent: true, opacity: 0, // starts invisible for fade-in
        });
        const mesh = new THREE.Mesh(this._geo(node.half), mat);
        mesh.position.set(node.cx, 0, node.cz);

        // Wireframe slightly above tile to avoid z-fighting
        const wire = new THREE.LineSegments(this._edges(node.half), this.wireMat);
        wire.position.set(node.cx, 0.0005, node.cz);

        this.scene.add(mesh);
        this.wireGroup.add(wire);
        this.pool.set(k, { mesh, wire, tex, mat, born: now, streamed: false });

        // Try to load real tile from server
        if (this._streaming !== false) {
          this._requestTile(node, k);
        }
      }
    }

    // Update existing / remove stale
    for (const [k, e] of this.pool) {
      if (wantedKeys.has(k)) {
        const age = now - e.born;
        const t = this._fadeMs > 0 ? Math.min(age / this._fadeMs, 1) : 1;
        e.mat.opacity = t;
        e.mat.transparent = t < 1;
      } else {
        this.scene.remove(e.mesh);
        this.wireGroup.remove(e.wire);
        // Only dispose procedural textures (streamed textures belong to _texCache)
        if (!e.streamed) e.tex.dispose();
        e.mat.dispose();
        this.pool.delete(k);
      }
    }

    this.wireGroup.visible = showWires;
  }

  get count() { return this.pool.size; }
  get streamingActive() { return this._streaming === true; }
  get tilesLoaded() { return this._loaded; }
  get tilesInFlight() { return this._inflight.size; }
}
