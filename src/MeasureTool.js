import * as THREE from 'three';

/** Format a distance in mm: `12.4 mm` below 100 mm, `3.21 cm` from there up. */
export function formatDistanceMM(mm) {
  return mm >= 100 ? `${(mm / 10).toFixed(2)} cm` : `${mm.toFixed(1)} mm`;
}

/** XZ-plane distance between two points, in mm. */
export function planarDistanceMM(a, b, mmPerUnit) {
  return Math.hypot(b.x - a.x, b.z - a.z) * mmPerUnit;
}

/** Straight-line 3D distance from planar distance and elevation delta (mm). */
export function chord3DMM(planarMM, dhMM) {
  return Math.hypot(planarMM, dhMM);
}

/** Measurement label: 3D distance primary, Δh secondary; planar-only when Δh unknown. */
export function measurementLabel(planarMM, dhMM) {
  if (dhMM == null) return formatDistanceMM(planarMM);
  return `${formatDistanceMM(chord3DMM(planarMM, dhMM))} · Δh ${formatDistanceMM(dhMM)}`;
}

/** n+1 points interpolated along the segment a→b (planar). */
export function segmentSamples(a, b, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, t });
  }
  return out;
}

/**
 * Map sampled norms to pixel-space polylines for the profile chart.
 * Null samples split the line (no interpolation across gaps).
 * Returns { segments, minMM, maxMM }; pad insets the drawing area vertically.
 */
export function buildProfilePath(norms, heightRangeMM, w, h, pad) {
  const mms = norms.map(n => (n == null ? null : n * heightRangeMM));
  const known = mms.filter(v => v != null);
  const minMM = Math.min(...known);
  const maxMM = Math.max(...known);
  const span = maxMM - minMM;
  const innerH = h - pad * 2;
  const segments = [];
  let current = null;
  mms.forEach((v, i) => {
    if (v == null) { current = null; return; }
    const px = (i / (mms.length - 1)) * w;
    const py = span === 0
      ? pad + innerH / 2
      : pad + (1 - (v - minMM) / span) * innerH;
    if (!current) { current = []; segments.push(current); }
    current.push({ px, py });
  });
  return { segments, minMM, maxMM };
}

/**
 * Monospace canvas-sprite label (low opacity white, like the rest of the UI).
 * Pass `background` (any CSS colour) to draw a HUD-style chip behind the text,
 * for labels that must stay legible over the object itself.
 */
export function makeLabel(text, size, opacity = 0.45, background = null) {
  const canvas = document.createElement('canvas');
  const scale = 4;
  canvas.width = 128 * scale;
  canvas.height = 32 * scale;
  const ctx = canvas.getContext('2d');
  ctx.font = `${11 * scale}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (background) {
    const pad = 6 * scale;
    const w = ctx.measureText(text).width + pad * 2;
    const h = 18 * scale;
    ctx.fillStyle = background;
    ctx.fillRect((canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }
  ctx.fillStyle = `rgba(255,255,255,${opacity})`;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size * 4, size, 1);
  return sprite;
}

const MARKER_OPACITY = 0.85;
const LINE_OPACITY   = 0.35;   // ruler line weight
const GHOST_OPACITY  = 0.15;
const PROFILE_SAMPLES = 96;

/**
 * Point-to-point in-plane measurement tool.
 *
 * All measurement graphics are white. The red accent is only used for the
 * orbit pivot. Picking raycasts the mid-displacement plane, the same
 * approximation as the surface-orbit pivot.
 */
export class MeasureTool {
  constructor({ scene, camera, domElement, terrain, mmPerUnit, onStateChange }) {
    this._camera = camera;            // () => camera, like LightSphere
    this._domElement = domElement;
    this._terrain = terrain;
    this._mmPerUnit = mmPerUnit;
    this._onStateChange = onStateChange ?? (() => {});

    this.armed = false;
    this._pending = null;             // first point of an in-progress measurement
    this._measurements = [];          // pinned { group, markers, sprite }

    this._group = new THREE.Group();
    this._group.name = 'measurements';
    scene.add(this._group);

    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();

    this._ghost = this._makeSegment(GHOST_OPACITY);
    this._ghost.visible = false;
    this._group.add(this._ghost);

    // ── Elevation profile chip (latest pinned measurement) ────────────────
    this._profileData = null;
    this._profileEl = document.createElement('div');
    this._profileEl.id = 'measureProfile';
    this._profileHead = document.createElement('div');
    this._profileHead.className = 'mp-head';
    this._profileCanvas = document.createElement('canvas');
    this._profileCanvas.width = 460;   // 2x the CSS size, for crispness
    this._profileCanvas.height = 128;
    this._profileEl.append(this._profileHead, this._profileCanvas);
    document.body.appendChild(this._profileEl);
    this._onProfileMove = this._handleProfileMove.bind(this);
    this._onProfileLeave = () => this._renderProfile();
    this._profileCanvas.addEventListener('mousemove', this._onProfileMove);
    this._profileCanvas.addEventListener('mouseleave', this._onProfileLeave);

    // 3D probe: mirrors the hovered profile sample on the object
    this._probe = this._makeMarker();
    this._probe.material.opacity = 0.6;
    this._probe.visible = false;
    this._group.add(this._probe);

    this._v3 = new THREE.Vector3(); // reused for label→screen projection

    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    domElement.addEventListener('pointerdown', this._onPointerDown, true);
    domElement.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    this.armed = !this.armed;
    if (!this.armed) this._cancelPending();
    this._domElement.style.cursor = this.armed ? 'crosshair' : '';
    this._onStateChange(this.armed);
  }

  clearAll() {
    this._removePinned();
    this._cancelPending();
  }

  /** Per-frame: keep markers and labels at constant screen size. */
  update() {
    const cam = this._camera();
    const scaleFor = (p) => cam.position.distanceTo(p) * 0.006;
    for (const m of this._measurements) {
      for (const marker of m.markers) marker.scale.setScalar(scaleFor(marker.position));
      const s = cam.position.distanceTo(m.sprite.position) * 0.05;
      m.sprite.scale.set(s * 4, s, 1);
    }
    if (this._pending) {
      this._pending.marker.scale.setScalar(scaleFor(this._pending.point));
    }
    if (this._probe.visible) {
      this._probe.scale.setScalar(scaleFor(this._probe.position) * 0.8);
    }

    // Anchor each measurement's × button next to its distance label
    const rect = this._measurements.length ? this._domElement.getBoundingClientRect() : null;
    for (const m of this._measurements) {
      this._v3.copy(m.sprite.position).project(cam);
      if (this._v3.z < 1) {
        const px = rect.left + ((this._v3.x + 1) / 2) * rect.width;
        const py = rect.top + ((1 - this._v3.y) / 2) * rect.height;
        m.deleteBtn.style.left = `${Math.round(px + 52)}px`;
        m.deleteBtn.style.top = `${Math.round(py - 24)}px`;
        m.deleteBtn.style.display = 'block';
      } else {
        m.deleteBtn.style.display = 'none'; // label is behind the camera
      }
    }
  }

  dispose() {
    this._domElement.removeEventListener('pointerdown', this._onPointerDown, true);
    this._domElement.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('keydown', this._onKeyDown);
    this._profileCanvas.removeEventListener('mousemove', this._onProfileMove);
    this._profileCanvas.removeEventListener('mouseleave', this._onProfileLeave);
    this.clearAll();
    this._group.parent?.remove(this._group);
    this._profileEl.remove();
  }

  // ── internals ──────────────────────────────────────────────────────────

  _makeMarker() {
    return new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: MARKER_OPACITY, depthTest: false,
      }),
    );
  }

  _makeSegment(opacity) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(),
    ]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity, depthTest: false,
    }));
  }

  _setSegment(line, a, b) {
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
  }

  _pick(e) {
    const rect = this._domElement.getBoundingClientRect();
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
    this._ray.setFromCamera(ndc, this._camera());
    const t = this._terrain;
    // first pass: mid-displacement plane (phase 1 behaviour)
    this._plane.constant = -(t.zScale * t.zExaggeration * 0.5);
    if (!this._ray.ray.intersectPlane(this._plane, this._hit)) return null;
    let point = this._hit.clone();
    // refine once: move the plane to the sampled surface height, re-intersect
    let sample = t.sampleHeight(point.x, point.z);
    if (sample) {
      this._plane.constant = -(sample.norm * t.zScale * t.zExaggeration);
      if (this._ray.ray.intersectPlane(this._plane, this._hit)) {
        point = this._hit.clone();
        sample = t.sampleHeight(point.x, point.z) ?? sample;
      }
    }
    return { point, norm: sample ? sample.norm : null };
  }

  /** Height range (mm) of the active height field; measurements are snapshots. */
  _heightRangeMM() {
    const meta = this._terrain.metadata;
    return meta.heightFields?.[this._terrain.heightChannel]?.heightRangeMM
      ?? meta.heightRangeMM;
  }

  _handleProfileMove(e) {
    const d = this._profileData;
    if (!d) return;
    const rect = this._profileCanvas.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.round(frac * (d.norms.length - 1));
    this._renderProfile(Math.min(d.norms.length - 1, Math.max(0, i)));
  }

  /** Draw the profile chart; hoverIndex adds a hairline + readout in the header. */
  _renderProfile(hoverIndex = null) {
    const d = this._profileData;
    if (!d) return;
    const canvas = this._profileCanvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pad = 14;
    ctx.clearRect(0, 0, w, h);

    const { segments, minMM, maxMM } = buildProfilePath(d.norms, d.heightRangeMM, w, h, pad);

    // recessive range hairlines
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, pad); ctx.lineTo(w, pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, h - pad); ctx.lineTo(w, h - pad); ctx.stroke();

    // profile line (single series: white, no legend)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const seg of segments) {
      if (seg.length === 1) {          // isolated sample between gaps: a dot
        ctx.fillRect(seg[0].px - 1.5, seg[0].py - 1.5, 3, 3);
        continue;
      }
      ctx.beginPath();
      seg.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      ctx.stroke();
    }

    // muted annotations: height range left, total length right
    ctx.font = '18px monospace';       // 9px at CSS scale (canvas is 2x)
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`${maxMM.toFixed(2)} mm`, 6, pad);
    ctx.fillText(`${minMM.toFixed(2)} mm`, 6, h - pad);
    ctx.textAlign = 'right';
    ctx.fillText(formatDistanceMM(d.planarMM), w - 6, h - pad);

    // hover: hairline + nearest-sample readout, mirrored by the 3D probe
    if (hoverIndex != null && d.norms[hoverIndex] != null) {
      const t2 = hoverIndex / (d.norms.length - 1);
      const px = t2 * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
      const dist = t2 * d.planarMM;
      const hMM = d.norms[hoverIndex] * d.heightRangeMM;
      this._profileHead.textContent = `d ${formatDistanceMM(dist)} · h ${formatDistanceMM(hMM)}`;
      this._probe.position.lerpVectors(d.a, d.b, t2);
      this._probe.position.y =
        d.norms[hoverIndex] * this._terrain.zScale * this._terrain.zExaggeration;
      this._probe.visible = true;
      return;
    }
    this._probe.visible = false;
    this._profileHead.textContent = d.label;
  }

  _handlePointerDown(e) {
    if (!this.armed || e.button !== 0 || e.shiftKey) return;
    const hit = this._pick(e);
    if (!hit) return;
    e.stopPropagation();          // measurement clicks must not orbit
    e.preventDefault();

    if (!this._pending) {
      const marker = this._makeMarker();
      marker.position.copy(hit.point);
      this._group.add(marker);
      this._pending = { point: hit.point, norm: hit.norm, marker };
      this._ghost.visible = true;
      this._setSegment(this._ghost, hit.point, hit.point);
    } else {
      this._pin(this._pending, hit, this._pending.marker);
      this._pending = null;
      this._ghost.visible = false;
    }
  }

  _handlePointerMove(e) {
    if (!this.armed || !this._pending) return;
    const hit = this._pick(e);
    if (hit) this._setSegment(this._ghost, this._pending.point, hit.point);
  }

  _handleKeyDown(e) {
    if (e.key !== 'Escape' || !this.armed) return;
    if (this._pending) this._cancelPending();
    else this.toggle();
  }

  _pin(pA, pB, firstMarker) {
    const group = new THREE.Group();
    const markerB = this._makeMarker();
    markerB.position.copy(pB.point);

    const line = this._makeSegment(LINE_OPACITY);
    this._setSegment(line, pA.point, pB.point);

    const planarMM = planarDistanceMM(pA.point, pB.point, this._mmPerUnit);
    const dhMM = (pA.norm != null && pB.norm != null)
      ? Math.abs(pB.norm - pA.norm) * this._heightRangeMM()
      : null;
    const text = measurementLabel(planarMM, dhMM);
    // HUD-style chip: the label sits on the object, which can be bright paper
    const sprite = makeLabel(text, 0.01, 0.9, 'rgba(10,10,10,0.75)');
    sprite.position.lerpVectors(pA.point, pB.point, 0.5);

    this._group.remove(firstMarker);
    group.add(firstMarker, markerB, line, sprite);
    this._group.add(group);

    // Per-measurement × delete button, anchored to the label in update()
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'measure-delete';
    deleteBtn.setAttribute('aria-label', 'Delete measurement');
    deleteBtn.textContent = '×';
    document.body.appendChild(deleteBtn);

    const measurement = { group, markers: [firstMarker, markerB], sprite, deleteBtn, profile: null };
    deleteBtn.onclick = () => this._removeMeasurement(measurement);
    this._measurements.push(measurement);

    // Profile is stored per measurement; the chip shows the most recent one
    const norms = segmentSamples(pA.point, pB.point, PROFILE_SAMPLES)
      .map(p => this._terrain.sampleHeight(p.x, p.z)?.norm ?? null);
    if (norms.some(n => n != null)) {
      measurement.profile = {
        norms, planarMM, heightRangeMM: this._heightRangeMM(), label: text,
        a: pA.point.clone(), b: pB.point.clone(),
      };
      this._showProfile(measurement.profile);
    }
  }

  _showProfile(profile) {
    this._profileData = profile;
    if (profile) {
      this._renderProfile();
      this._profileEl.style.display = 'block';
    } else {
      this._profileEl.style.display = 'none';
      this._probe.visible = false;
    }
  }

  _removeMeasurement(m) {
    const i = this._measurements.indexOf(m);
    if (i === -1) return;
    this._measurements.splice(i, 1);
    this._group.remove(m.group);
    m.deleteBtn.remove();
    if (this._profileData === m.profile) {
      // fall back to the most recent remaining measurement with a profile
      const prev = [...this._measurements].reverse().find((x) => x.profile);
      this._showProfile(prev ? prev.profile : null);
    }
  }

  _cancelPending() {
    if (!this._pending) return;
    this._group.remove(this._pending.marker);
    this._pending = null;
    this._ghost.visible = false;
  }

  _removePinned() {
    for (const m of this._measurements) {
      this._group.remove(m.group);
      m.deleteBtn.remove();
    }
    this._measurements = [];
    this._showProfile(null);
  }
}
