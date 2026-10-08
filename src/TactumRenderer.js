/**
 * TactumRenderer: manages Three.js meshes with height-displaced ShaderMaterial
 *
 * Adapted for datasets with a floating point depthmap and RGB albedo.
 * Includes shadow mapping with PCSS soft shadows.
 */

import * as THREE from 'three';
import { tileUrl } from './tileUrl.js';
import { canRetire, isPresentable } from './lodTransition.js';
import vertexShader from './shaders/terrain.vert.glsl?raw';
import fragmentShader from './shaders/terrain.frag.glsl?raw';
import depthVertexShader from './shaders/depth.vert.glsl?raw';
import depthFragmentShader from './shaders/depth.frag.glsl?raw';

const DEFAULT_SEGMENTS = 256;
// Failsafe only: coverage is what normally releases a retired tile. Must be
// generous: on slow networks replacements can take many seconds, and if the
// old cover expires too early, the holes come back.
const RETIRE_TIMEOUT_MS = 15000;

export class TactumRenderer {
  constructor(scene, metadata, { zExaggeration = 1, segments = DEFAULT_SEGMENTS, shadowMapSize = 2048, usePCSS = true, tileBaseUrl = '../moss/', heightChannel = 'height', tileUrlBuilder = null, padTileSize = 0 } = {}) {
    this._segments = segments;
    this._usePCSS = usePCSS;
    this._tileUrlBuilder = tileUrlBuilder;
    this._padTileSize = padTileSize;
    this.scene = scene;
    this.metadata = metadata;
    this.heightChannel = heightChannel;
    this.zScale = metadata.zScale;
    this.zExaggeration = zExaggeration;
    this.tileBaseUrl = tileBaseUrl;
    this._meshWireframe = false;
    const az = THREE.MathUtils.degToRad(-135);
    const el = THREE.MathUtils.degToRad(45);
    this._lightDir = new THREE.Vector3(
      Math.cos(az) * Math.cos(el),
      Math.sin(el),
      Math.sin(az) * Math.cos(el),
    ).normalize();

    const dr = metadata.dataRegion;
    this._dataMinX = dr.x - 0.5;
    this._dataMaxX = dr.x + dr.width - 0.5;
    this._dataMinZ = dr.z - 0.5;
    this._dataMaxZ = dr.z + dr.height - 0.5;

    this.pool = new Map();
    this.geoCache = new Map();
    this._texCache = new Map();
    this._sampleCache = new WeakMap();  // texture -> ImageData, for sampleHeight
    this._inflight = new Set();
    this._loader = new THREE.TextureLoader();
    this._loaded = 0;

    this.wireGroup = new THREE.Group();
    this.wireGroup.name = 'terrain-wires';
    scene.add(this.wireGroup);
    this.wireMat = new THREE.LineBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.4,
      depthTest: false,
    });
    this.edgeCache = new Map();

    this._fadeMs = 250;
    this._fadeEnabled = false;

    // ── Shadow mapping ────────────────────────────────────────────────
    this._shadowEnabled = true;
    this._albedoEnabled = true;
    this._shadowMapSize = shadowMapSize;
    this._shadowBias = 0.001;
    this._shadowIntensity = 1.0;
    this._shadowSoftness = 0.1;
    this._shadowDirty = true;

    this._shadowRT = new THREE.WebGLRenderTarget(this._shadowMapSize, this._shadowMapSize);
    this._shadowRT.depthTexture = new THREE.DepthTexture(this._shadowMapSize, this._shadowMapSize);
    this._shadowRT.depthTexture.type = THREE.UnsignedIntType;

    this._shadowCam = new THREE.OrthographicCamera(-1, 1, -1, 1, 0.001, 2);
    this._lightMatrix = new THREE.Matrix4();
    this._updateShadowCamera();

    this._depthMaterials = new Map();

    this._blackTex = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat,
    );
    this._blackTex.needsUpdate = true;

    this._greyTex = new THREE.DataTexture(
      new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat,
    );
    this._greyTex.needsUpdate = true;
  }

  _geo(half) {
    const k = half.toFixed(8);
    if (!this.geoCache.has(k)) {
      const g = new THREE.PlaneGeometry(half * 2, half * 2, this._segments, this._segments);
      g.rotateX(-Math.PI / 2);
      this.geoCache.set(k, g);
    }
    return this.geoCache.get(k);
  }

  _edges(half) {
    const k = half.toFixed(8);
    if (!this.edgeCache.has(k)) {
      const g = new THREE.PlaneGeometry(half * 2, half * 2);
      g.rotateX(-Math.PI / 2);
      this.edgeCache.set(k, new THREE.EdgesGeometry(g));
    }
    return this.edgeCache.get(k);
  }

  _isInDataRegion(node) {
    const minX = node.cx - node.half;
    const maxX = node.cx + node.half;
    const minZ = node.cz - node.half;
    const maxZ = node.cz + node.half;
    return (
      maxX > this._dataMinX && minX < this._dataMaxX &&
      maxZ > this._dataMinZ && minZ < this._dataMaxZ
    );
  }

  _tileUrl(node, channel) {
    if (this._tileUrlBuilder) return this._tileUrlBuilder(channel, node);
    return tileUrl(this.tileBaseUrl, channel, node);
  }

  // IIIF level-0 edge tiles are cropped to the image bounds; the shader
  // expects full-size tiles, so pad them back (exact pixel copy, top-left).
  _padTexture(tex) {
    const size = this._padTileSize;
    const img = tex.image;
    if (img.width === size && img.height === size) return tex;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const out = new THREE.CanvasTexture(canvas);
    out.minFilter = THREE.LinearFilter;
    out.magFilter = THREE.LinearFilter;
    out.generateMipmaps = false;
    tex.dispose();
    return out;
  }

  _loadTexture(url, callback) {
    if (this._texCache.has(url)) {
      callback(this._texCache.get(url));
      return;
    }
    if (this._inflight.has(url)) return;
    this._inflight.add(url);

    this._loader.loadAsync(url)
      .then(tex => {
        if (this._padTileSize) tex = this._padTexture(tex);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        this._texCache.set(url, tex);
        this._inflight.delete(url);
        this._loaded++;
        callback(tex);
      })
      .catch(() => {
        this._inflight.delete(url);
        this._texCache.set(url, null);
        callback(null);
      });
  }

  /** Mark the entry ready once every texture it needs has arrived. */
  _checkReady(entry) {
    if (entry.ready || entry.failed) return;
    const needsHeight = !!this.heightChannel;
    if (entry.albedoLoaded && (!needsHeight || entry.heightLoaded)) {
      entry.ready = true;
      entry.readyAt = performance.now();
      this._shadowDirty = true;
    }
  }

  _createMaterial() {
    const fragSrc = this._usePCSS
      ? '#define USE_PCSS\n' + fragmentShader
      : fragmentShader;
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: fragSrc,
      uniforms: {
        heightMap: { value: this._blackTex },
        albedoMap: { value: this._greyTex },
        albedoEnabled: { value: this._albedoEnabled },
        zScale: { value: this.zScale },
        zExaggeration: { value: this.zExaggeration },
        tileSize: { value: 1.0 },
        lightDir: { value: this._lightDir.clone() },
        ambientColor: { value: new THREE.Vector3(0.3, 0.3, 0.35) },
        lightColor: { value: new THREE.Vector3(0.8, 0.78, 0.75) },
        opacity: { value: 0 },
        lightMatrix: { value: this._lightMatrix },
        shadowMap: { value: this._shadowRT.depthTexture },
        shadowBias: { value: this._shadowBias },
        shadowIntensity: { value: this._shadowIntensity },
        shadowEnabled: { value: this._shadowEnabled },
        shadowSoftness: { value: this._shadowSoftness },
      },
      transparent: true,
      side: THREE.DoubleSide,
    });
  }

  setHeightChannel(channel, zScale) {
    this.heightChannel = channel;
    if (zScale != null) this.zScale = zScale;
    for (const [k, entry] of this.pool) {
      entry.mat.uniforms.zScale.value = this.zScale;
      this._loadTexture(this._tileUrl(entry.node, channel), (tex) => {
        const e = this.pool.get(k);
        if (!e || !tex) return;
        if (this.heightChannel !== channel) return; // stale switch
        e.mat.uniforms.heightMap.value = tex;
        e.heightLoaded = true;
        this._shadowDirty = true;
        this._checkReady(e);
      });
    }
    this._shadowDirty = true;
  }

  /**
   * Read the normalised height [0..1] at world (x, z) from the deepest
   * loaded tile texture. Synchronous: samples what is currently displayed.
   * Returns { norm, level } or null when no loaded tile covers the point.
   */
  sampleHeight(x, z) {
    let best = null;
    for (const entry of this.pool.values()) {
      if (!entry.heightLoaded) continue;
      const n = entry.node;
      if (x < n.cx - n.half || x > n.cx + n.half) continue;
      if (z < n.cz - n.half || z > n.cz + n.half) continue;
      if (!best || n.level > best.node.level) best = entry;
    }
    if (!best) return null;

    const tex = best.mat.uniforms.heightMap.value;
    const img = tex.image;
    if (!img || !img.width) return null;

    let data = this._sampleCache.get(tex);
    if (!data) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        data = ctx.getImageData(0, 0, img.width, img.height);
      } catch {
        return null; // cross-origin tile tainted the canvas
      }
      this._sampleCache.set(tex, data);
    }

    const n = best.node;
    // world -z (top of the plate) maps to image row 0 (flipY texture upload)
    const u = (x - (n.cx - n.half)) / (n.half * 2);
    const py = Math.round(((z - (n.cz - n.half)) / (n.half * 2)) * (img.height - 1));
    const px = Math.round(u * (img.width - 1));
    const cx = Math.min(img.width - 1, Math.max(0, px));
    const cy = Math.min(img.height - 1, Math.max(0, py));
    const i = (cy * img.width + cx) * 4;
    const norm = (data.data[i] * 256 + data.data[i + 1]) / 65535;
    return { norm, level: n.level };
  }

  setZExaggeration(val) {
    this.zExaggeration = val;
    for (const [, entry] of this.pool) {
      entry.mat.uniforms.zExaggeration.value = val;
    }
    this._shadowDirty = true;
  }

  setFadeEnabled(on) { this._fadeEnabled = on; }

  setMeshWireframe(on) {
    this._meshWireframe = on;
    for (const [, entry] of this.pool) {
      entry.mat.wireframe = on;
    }
  }

  setLightDir(vec) {
    this._lightDir.copy(vec);
    for (const [, entry] of this.pool) {
      entry.mat.uniforms.lightDir.value.copy(vec);
    }
    this._shadowDirty = true;
    this._updateShadowCamera();
  }

  // ── Shadow mapping ──────────────────────────────────────────────────────

  _updateShadowCamera() {
    const cam = this._shadowCam;
    const dr = this.metadata.dataRegion;

    const cx = dr.x + dr.width / 2 - 0.5;
    const cz = dr.z + dr.height / 2 - 0.5;
    const halfW = dr.width / 2;
    const halfH = dr.height / 2;
    const maxExtent = Math.max(halfW, halfH) * 1.1;

    const maxY = this.zScale * this.zExaggeration * 1.5;
    const target = new THREE.Vector3(cx, maxY / 2, cz);
    cam.position.copy(target).addScaledVector(this._lightDir, 1.0);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);

    cam.left = -maxExtent;
    cam.right = maxExtent;
    cam.top = maxExtent;
    cam.bottom = -maxExtent;
    cam.near = 0.001;
    cam.far = 2.0 + maxY;
    cam.updateProjectionMatrix();

    this._lightMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  _createDepthMaterial() {
    return new THREE.ShaderMaterial({
      vertexShader: depthVertexShader,
      fragmentShader: depthFragmentShader,
      uniforms: {
        heightMap: { value: this._blackTex },
        zScale: { value: this.zScale },
        zExaggeration: { value: this.zExaggeration },
      },
    });
  }

  renderShadowMap(renderer) {
    if (!this._shadowEnabled) return;
    if (!this._shadowDirty) return;
    this._shadowDirty = false;

    this._updateShadowCamera();

    renderer.setRenderTarget(this._shadowRT);
    renderer.clear();

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    for (const [k, entry] of this.pool) {
      if (!entry.mesh.visible) continue;

      if (!this._depthMaterials.has(k)) {
        this._depthMaterials.set(k, this._createDepthMaterial());
      }
      const depthMat = this._depthMaterials.get(k);

      depthMat.uniforms.heightMap.value = entry.mat.uniforms.heightMap.value;
      depthMat.uniforms.zScale.value = this.zScale;
      depthMat.uniforms.zExaggeration.value = this.zExaggeration;

      const origMat = entry.mesh.material;
      entry.mesh.material = depthMat;
      renderer.render(entry.mesh, this._shadowCam);
      entry.mesh.material = origMat;
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(null);
  }

  setShadowEnabled(on) { this._shadowEnabled = on; }

  /** Colour on, or the bare surface in mid grey (masked background stays black). */
  setAlbedoEnabled(on) {
    this._albedoEnabled = on;
    for (const [, entry] of this.pool) {
      entry.mat.uniforms.albedoEnabled.value = on;
    }
  }

  setShadowBias(val) {
    this._shadowBias = val;
    for (const [, entry] of this.pool) {
      entry.mat.uniforms.shadowBias.value = val;
    }
  }
  setShadowIntensity(val) {
    this._shadowIntensity = val;
    for (const [, entry] of this.pool) {
      entry.mat.uniforms.shadowIntensity.value = val;
    }
  }
  setShadowSoftness(val) {
    this._shadowSoftness = val;
    for (const [, entry] of this.pool) {
      entry.mat.uniforms.shadowSoftness.value = val;
    }
  }

  _disposeEntry(k, e) {
    this.scene.remove(e.mesh);
    this.wireGroup.remove(e.wire);
    e.mat.dispose();
    this.pool.delete(k);
    if (this._depthMaterials.has(k)) {
      this._depthMaterials.get(k).dispose();
      this._depthMaterials.delete(k);
    }
    this._shadowDirty = true;
  }

  update(leaves, showWires) {
    const wantedKeys = new Set();
    const now = performance.now();

    for (const node of leaves) {
      if (!this._isInDataRegion(node)) continue;

      const k = node.key;
      wantedKeys.add(k);

      if (!this.pool.has(k)) {
        const mat = this._createMaterial();
        mat.uniforms.tileSize.value = node.half * 2;
        mat.wireframe = this._meshWireframe;
        const mesh = new THREE.Mesh(this._geo(node.half), mat);
        mesh.position.set(node.cx, 0, node.cz);
        mesh.frustumCulling = false;

        const wire = new THREE.LineSegments(this._edges(node.half), this.wireMat);
        wire.position.set(node.cx, 0, node.cz);

        mesh.visible = false;
        wire.visible = false;
        this.scene.add(mesh);
        this.wireGroup.add(wire);

        const entry = {
          mesh, wire, mat, node, born: now,
          heightLoaded: false, albedoLoaded: false,
          ready: false, readyAt: 0,
          retiring: false, retiredAt: 0,
        };
        this.pool.set(k, entry);
        this._shadowDirty = true;

        const channel = this.heightChannel;
        if (channel) {
          const heightUrl = this._tileUrl(node, channel);
          this._loadTexture(heightUrl, (tex) => {
            const e = this.pool.get(k);
            if (!e) return;
            if (!tex) { e.failed = true; return; }
            if (this.heightChannel !== channel) return; // stale switch
            e.mat.uniforms.heightMap.value = tex;
            e.heightLoaded = true;
            this._shadowDirty = true;
            this._checkReady(e);
          });
        }

        const albedoUrl = this._tileUrl(node, 'albedo');
        this._loadTexture(albedoUrl, (tex) => {
          const e = this.pool.get(k);
          if (!e) return;
          if (!tex) { e.failed = true; return; }
          e.mat.uniforms.albedoMap.value = tex;
          e.albedoLoaded = true;
          this._checkReady(e);
        });
      }

      const e0 = this.pool.get(k);
      if (e0) e0.node = node;  // keep the freshest node
    }

    for (const [k, e] of this.pool) {
      if (wantedKeys.has(k)) {
        if (e.retiring) {
          // Camera came back, so reuse in place with no reload. Clamp the fade so a
          // solidified tile doesn't dim back to a partial opacity.
          e.retiring = false;
          e.readyAt = Math.min(e.readyAt, now - this._fadeMs);
        }
        if (e.failed || !e.ready) {
          e.mesh.visible = false;
          e.wire.visible = false;
          continue;
        }
        e.mesh.visible = true;
        e.wire.visible = true;
        const fadeMs = this._fadeEnabled ? this._fadeMs : 0;
        const t = fadeMs > 0 ? Math.min((now - e.readyAt) / fadeMs, 1) : 1;
        const fading = t < 1;
        e.mat.uniforms.opacity.value = t;
        e.mat.transparent = fading;
        if (e.mat.polygonOffset !== fading) {
          e.mat.polygonOffset = fading;
          e.mat.polygonOffsetFactor = fading ? -1 : 0;
          e.mat.polygonOffsetUnits = fading ? -1 : 0;
        }
      } else if (!e.retiring) {
        if (!e.ready) {
          // Never showed anything (loading or failed), so nothing to preserve.
          this._disposeEntry(k, e);
        } else {
          e.retiring = true;
          e.retiredAt = now;
          // Solidify: what's on screen must fully cover what's beneath it,
          // even if this tile was itself mid-fade when it was retired.
          e.mat.uniforms.opacity.value = 1;
          e.mat.transparent = false;
          // Push retiring geometry behind wanted content so neither a fading
          // nor a freshly-solidified replacement can z-fight with it.
          e.mat.polygonOffset = true;
          e.mat.polygonOffsetFactor = 1;
          e.mat.polygonOffsetUnits = 1;
          e.mesh.visible = true;
          e.wire.visible = true;
          this._shadowDirty = true;
        }
      }
    }

    // Dispose retiring tiles whose area is covered by presentable content.
    // `wanted` is built lazily: most frames have nothing retiring.
    let wanted = null;
    const fadeMs = this._fadeEnabled ? this._fadeMs : 0;
    for (const [k, e] of this.pool) {
      if (!e.retiring) continue;
      if (now - e.retiredAt <= RETIRE_TIMEOUT_MS) {
        if (!wanted) {
          wanted = [];
          for (const we of this.pool.values()) {
            if (we.retiring) continue;
            wanted.push({
              cx: we.node.cx, cz: we.node.cz, half: we.node.half,
              presentable: isPresentable(we, now, fadeMs),
            });
          }
        }
        if (!canRetire(e.node, wanted)) continue;
      }
      this._disposeEntry(k, e);
    }

    this.wireGroup.visible = showWires;
  }

  get count() { return this.pool.size; }
  get polygons() { return this.pool.size * this._segments * this._segments * 2; }
  get tilesLoaded() { return this._loaded; }
  get tilesInFlight() { return this._inflight.size; }

  get dataCentre() {
    return new THREE.Vector3(
      (this._dataMinX + this._dataMaxX) / 2,
      0,
      (this._dataMinZ + this._dataMaxZ) / 2,
    );
  }
}
