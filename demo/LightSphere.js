import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';

const DEG5  = (5 * Math.PI) / 180;
const DEG85 = (85 * Math.PI) / 180;
const SENSITIVITY = Math.PI / 400; // radians per pixel
const ARC_SEGS = 24;

export class LightSphere {
  constructor({ scene, camera, domElement, controls, terrain, animCheckbox, screenFraction = 0.12 }) {
    this._scene = scene;
    this._camera = camera;
    this._dom = domElement;
    this._controls = controls;
    this._terrain = terrain;
    this._animCb = animCheckbox;
    this._screenFraction = screenFraction;

    this._azimuth = 0;
    this._elevation = Math.PI / 4;
    this._active = false;
    this._pointerId = -1;
    this._prevX = 0;
    this._prevY = 0;
    this._lightMode = false;

    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._raycaster = new THREE.Raycaster();
    this._hitPoint = new THREE.Vector3();

    this._buildGizmo();

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);

    this._dom.addEventListener('pointerdown', this._onPointerDown, { capture: true });
  }

  get azimuth()   { return this._azimuth; }
  get elevation() { return this._elevation; }
  get isActive()  { return this._active; }
  get lightMode()    { return this._lightMode; }
  set lightMode(val) { this._lightMode = !!val; }

  setAngles(az, el) {
    this._azimuth = az;
    this._elevation = THREE.MathUtils.clamp(el, DEG5, DEG85);
    this._updateVisuals();
  }

  dispose() {
    this._dom.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this._scene.remove(this._group);
  }

  _buildGizmo() {
    this._group = new THREE.Group();
    this._group.visible = false;

    const res = new THREE.Vector2(this._dom.clientWidth, this._dom.clientHeight);

    const makePair = (numVerts) => {
      const backGeo = new LineGeometry();
      const backMat = new LineMaterial({
        color: 0x999999, transparent: true, opacity: 0.3,
        linewidth: 3, depthTest: false, resolution: res,
      });
      const back = new Line2(backGeo, backMat);
      back.renderOrder = 998;
      this._group.add(back);

      const positions = new Float32Array(numVerts * 3);
      const frontGeo = new THREE.BufferGeometry();
      frontGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const front = new THREE.Line(frontGeo, new THREE.LineBasicMaterial({
        color: 0x222222, transparent: true, opacity: 0.6, depthTest: false,
      }));
      front.renderOrder = 999;
      this._group.add(front);

      return { back, backGeo, front, frontGeo, positions };
    };

    this._ray    = makePair(2);
    this._ground = makePair(2);
    this._arc    = makePair(ARC_SEGS + 1);

    this._ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffcc44, transparent: true, opacity: 0.9, depthTest: false,
      }),
    );
    this._ball.renderOrder = 1000;
    this._group.add(this._ball);

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.4, depthTest: false,
      }),
    );
    dot.renderOrder = 1000;
    this._group.add(dot);

    this._scene.add(this._group);
    this._updateVisuals();
  }

  _updateVisuals() {
    const az = this._azimuth;
    const el = this._elevation;
    const cosAz = Math.cos(az), sinAz = Math.sin(az);
    const cosEl = Math.cos(el), sinEl = Math.sin(el);

    const sunX = cosAz * cosEl;
    const sunY = sinEl;
    const sunZ = sinAz * cosEl;

    const rp = this._ray.positions;
    rp[3] = sunX; rp[4] = sunY; rp[5] = sunZ;
    this._ray.frontGeo.attributes.position.needsUpdate = true;
    this._ray.backGeo.setPositions([0, 0, 0, sunX, sunY, sunZ]);

    const gp = this._ground.positions;
    gp[3] = cosAz; gp[5] = sinAz;
    this._ground.frontGeo.attributes.position.needsUpdate = true;
    this._ground.backGeo.setPositions([0, 0, 0, cosAz, 0, sinAz]);

    const ap = this._arc.positions;
    const arcFlat = [];
    for (let i = 0; i <= ARC_SEGS; i++) {
      const t = (i / ARC_SEGS) * el;
      const idx = i * 3;
      const x = cosAz * Math.cos(t);
      const y = Math.sin(t);
      const z = sinAz * Math.cos(t);
      ap[idx] = x; ap[idx + 1] = y; ap[idx + 2] = z;
      arcFlat.push(x, y, z);
    }
    this._arc.frontGeo.attributes.position.needsUpdate = true;
    this._arc.backGeo.setPositions(arcFlat);

    this._ball.position.set(sunX, sunY, sunZ);
  }

  _dirVector() {
    return new THREE.Vector3(
      Math.cos(this._azimuth) * Math.cos(this._elevation),
      Math.sin(this._elevation),
      Math.sin(this._azimuth) * Math.cos(this._elevation),
    ).normalize();
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    if (!this._lightMode && !e.shiftKey) return;

    const rect = this._dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(ndc, this._camera());
    const hit = this._raycaster.ray.intersectPlane(this._groundPlane, this._hitPoint);
    if (!hit) {
      if (!this._lightMode) return;
      this._hitPoint.copy(this._controls.target);
    }

    e.stopPropagation();

    this._group.position.copy(this._hitPoint);
    const dist = this._camera().position.distanceTo(this._hitPoint);
    this._group.scale.setScalar(dist * this._screenFraction);
    this._group.visible = true;

    this._controls.enabled = false;
    if (this._animCb.checked) {
      this._animCb.checked = false;
      this._animCb.dispatchEvent(new Event('change'));
    }

    this._active = true;
    this._pointerId = e.pointerId;
    this._prevX = e.clientX;
    this._prevY = e.clientY;

    this._dom.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);

    this._updateVisuals();
    this._terrain.setLightDir(this._dirVector());
  }

  _onPointerMove(e) {
    if (!this._active) return;

    const dx = e.clientX - this._prevX;
    const dy = e.clientY - this._prevY;
    this._prevX = e.clientX;
    this._prevY = e.clientY;

    this._azimuth -= dx * SENSITIVITY;
    this._elevation = THREE.MathUtils.clamp(
      this._elevation - dy * SENSITIVITY,
      DEG5, DEG85,
    );

    this._updateVisuals();
    this._terrain.setLightDir(this._dirVector());
  }

  _onPointerUp(e) {
    if (!this._active) return;

    this._active = false;
    this._group.visible = false;
    this._controls.enabled = true;

    if (this._pointerId >= 0) {
      try { this._dom.releasePointerCapture(this._pointerId); } catch (_) { /* ok */ }
      this._pointerId = -1;
    }

    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
  }
}
