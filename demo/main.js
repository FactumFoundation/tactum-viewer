/**
 * Tactum Demo: Nature-printed moss (Alois Auer, 1853)
 *
 * Float32 depthmaps + RGB albedo from a nature-printed moss plate (Alois
 * Auer's Naturselbstdruck process, 1853). Two switchable height fields:
 * HF-filtered relief (0.31 mm) and full surface including paper warp (1.57 mm).
 * GPU vertex displacement with Lambertian lighting and PCSS shadow mapping.
 *
 * Requires tiles:
 *   python scripts/generate_tiles.py
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { QuadTree } from '../src/QuadTree.js';
import { TactumRenderer } from '../src/TactumRenderer.js';
import { loadIIIFDataset } from '../src/iiif.js';
import { MeasureTool, makeLabel } from '../src/MeasureTool.js';
import { InfoOverlay } from '../src/InfoOverlay.js';
import { createBackgroundDome } from '../src/BackgroundDome.js';
import { LightSphere } from './LightSphere.js';

const GRID_CENTER_COLOR = 0x2a2a2a;
const GRID_LINE_COLOR   = 0x1a1a1a;
const CLEAR_COLOR       = 0x0a0a0a;

// Per-field default Z exaggeration (full surface is ~5x the HF relief)
const DEFAULT_Z_EXAG = { height_hf: 4.0, height_full: 1.0 };

// ── Scale ruler ──────────────────────────────────────────────────────────

function createRuler(metadata, mmPerUnit) {
  const group = new THREE.Group();
  group.name = 'ruler';

  const dr = metadata.dataRegion;
  const x0 = dr.x - 0.5;
  const z0 = dr.z + dr.height - 0.5;
  const xEnd = dr.x + dr.width - 0.5;
  const zEnd = dr.z - 0.5;

  const stepMM = 10;
  const stepWorld = stepMM / mmPerUnit;
  const tickH = 0.002;
  const tickHMinor = 0.001;
  const rulerY = -0.001;
  const offset = 0.008;

  const lineMat = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.3, depthTest: false,
  });

  // ── X axis ruler ──
  const xRulerZ = z0 + offset;
  const xPts = [new THREE.Vector3(x0, rulerY, xRulerZ), new THREE.Vector3(xEnd, rulerY, xRulerZ)];
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(xPts), lineMat));

  const xLenMM = (xEnd - x0) * mmPerUnit;
  for (let mm = 0; mm <= xLenMM; mm += stepMM / 2) {
    const x = x0 + mm / mmPerUnit;
    if (x > xEnd + 0.0001) break;
    const isMajor = mm % stepMM === 0;
    const h = isMajor ? tickH : tickHMinor;
    const pts = [new THREE.Vector3(x, rulerY, xRulerZ), new THREE.Vector3(x, rulerY, xRulerZ + h)];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));

    if (isMajor) {
      const label = mm >= 10 ? `${mm / 10}cm` : '0';
      const sprite = makeLabel(label, stepWorld * 0.18);
      sprite.position.set(x, rulerY, xRulerZ + h + stepWorld * 0.1);
      group.add(sprite);
    }
  }

  // ── Z axis ruler ──
  const zRulerX = x0 - offset;
  const zPts = [new THREE.Vector3(zRulerX, rulerY, z0), new THREE.Vector3(zRulerX, rulerY, zEnd)];
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(zPts), lineMat));

  const zLenMM = (z0 - zEnd) * mmPerUnit;
  for (let mm = 0; mm <= zLenMM; mm += stepMM / 2) {
    const z = z0 - mm / mmPerUnit;
    if (z < zEnd - 0.0001) break;
    const isMajor = mm % stepMM === 0;
    const h = isMajor ? tickH : tickHMinor;
    const pts = [new THREE.Vector3(zRulerX, rulerY, z), new THREE.Vector3(zRulerX - h, rulerY, z)];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));

    if (isMajor && mm > 0) {
      const label = `${mm / 10}cm`;
      const sprite = makeLabel(label, stepWorld * 0.18);
      sprite.position.set(zRulerX - h - stepWorld * 0.15, rulerY, z);
      group.add(sprite);
    }
  }

  return group;
}

async function init() {
  // Embed mode (?embed): hide the instrumentation, keep the interaction.
  if (new URLSearchParams(location.search).has('embed')) {
    document.body.classList.add('embed');
  }
  // ── Data source: IIIF manifest (?manifest=<url>) or local metadata.json ──
  const manifestParam = new URLSearchParams(location.search).get('manifest');
  let metadata, tileUrlBuilder = null;
  if (manifestParam) {
    const ds = await loadIIIFDataset(new URL(manifestParam, location.href).href);
    metadata = ds.metadata;
    tileUrlBuilder = ds.tileUrlFor;
  } else {
    metadata = await fetch('../moss/metadata.json').then(r => r.json());
  }

  // Append the real height range to each height-field label, so the numbers
  // always match the loaded dataset instead of being hard-coded in the markup.
  if (metadata.heightFields) {
    const hfRange = document.getElementById('heightHfRange');
    const fullRange = document.getElementById('heightFullRange');
    if (hfRange && metadata.heightFields.height_hf) {
      hfRange.textContent = ` (${metadata.heightFields.height_hf.heightRangeMM.toFixed(2)} mm)`;
    }
    if (fullRange && metadata.heightFields.height_full) {
      fullRange.textContent = ` (${metadata.heightFields.height_full.heightRangeMM.toFixed(2)} mm)`;
    }
  }

  // ── Mobile detection ──────────────────────────────────────────────────
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // ── Renderer ──────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, preserveDrawingBuffer: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(CLEAR_COLOR, 0);
  document.body.appendChild(renderer.domElement);
  // (background class applied in the Background section from the checked radio)

  // ── Camera ────────────────────────────────────────────────────────────
  const aspect = window.innerWidth / window.innerHeight;
  const perspCam = new THREE.PerspectiveCamera(60, aspect, 0.001, 100);

  const dr = metadata.dataRegion;
  const cx = dr.x + dr.width / 2 - 0.5;
  const cz = dr.z + dr.height / 2 - 0.5;
  perspCam.position.set(cx + 0.2, 0.4, cz + 0.3);
  perspCam.lookAt(cx, 0, cz);

  const camera = perspCam;

  // ── Controls ──────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(cx, 0, cz);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.02;
  controls.maxDistance = 5;
  controls.maxPolarAngle = Math.PI * 0.48;

  // ── Scene ─────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();

  const grid = new THREE.GridHelper(2, 20, GRID_CENTER_COLOR, GRID_LINE_COLOR);
  grid.position.y = -0.002;
  scene.add(grid);
  const axesHelper = new THREE.AxesHelper(0.25);
  axesHelper.visible = false;
  scene.add(axesHelper);

  // ── Scale ruler (needs a physical pixel size) ─────────────────────────
  if (metadata.pixelSizeMM) {
    const mmPerUnit = metadata.canvasSize * metadata.pixelSizeMM;
    scene.add(createRuler(metadata, mmPerUnit));
  }

  // ── QuadTree + TactumRenderer ────────────────────────────────────────
  let heightChannel = metadata.defaultHeightChannel;
  const quadTree = new QuadTree({ maxLevel: metadata.maxLevel });
  const terrain = new TactumRenderer(scene, metadata, {
    zExaggeration: DEFAULT_Z_EXAG[heightChannel] ?? 1.0,
    segments: isMobile ? 128 : 256,
    shadowMapSize: isMobile ? 1024 : 2048,
    usePCSS: !isMobile,
    tileBaseUrl: '../moss/',
    heightChannel,
    tileUrlBuilder,
    padTileSize: tileUrlBuilder ? metadata.tileSize : 0,
  });
  terrain.setFadeEnabled(false);

  // ── Light sphere gizmo ────────────────────────────────────────────────
  const lightSphere = new LightSphere({
    scene,
    camera: () => camera,
    domElement: renderer.domElement,
    controls,
    terrain,
    animCheckbox: document.getElementById('animateLight'),
  });
  lightSphere.setAngles(THREE.MathUtils.degToRad(-135), Math.PI / 4);

  const $lightToggle = document.getElementById('lightToggle');
  const $help = document.getElementById('help');
  // The mouse-bindings bar is hidden in this example: the viewer is shown on
  // touch screens and embedded in iframes where it collides with the host
  // caption. The element stays in the DOM (measure/light modes write to it).
  $help.style.display = 'none';

  // ── Measure tool ──────────────────────────────────────────────────────
  const $measureToggle = document.getElementById('measureToggle');
  const $measureClear = document.getElementById('measureClear');
  const HELP_DEFAULT = 'LMB: orbit &nbsp;|&nbsp; RMB: pan &nbsp;|&nbsp; Scroll: zoom &nbsp;|&nbsp; Shift+LMB: light direction';
  let measure = null;
  if (metadata.pixelSizeMM) {
    measure = new MeasureTool({
      scene,
      camera: () => camera,
      domElement: renderer.domElement,
      terrain,
      mmPerUnit: metadata.canvasSize * metadata.pixelSizeMM,
      onStateChange: (armed) => {
        $measureToggle.classList.toggle('active', armed);
        if (armed && lightSphere.lightMode) $lightToggle.click();
        $help.innerHTML = armed
          ? 'Click two points to measure &nbsp;|&nbsp; Esc: exit'
          : HELP_DEFAULT;
      },
    });
    $measureToggle.onclick = () => measure.toggle();
    $measureClear.onclick = (e) => { e.preventDefault(); measure.clearAll(); };
  } else {
    $measureToggle.style.display = 'none';
    $measureClear.style.display = 'none';
  }

  // ── Museum info overlay ────────────────────────────────────────────────
  const infoOverlay = new InfoOverlay({
    metadata,
    infoUrl: '../moss/info.json',
    button: document.getElementById('infoToggle'),
  });

  // ── Surface-anchored orbit pivot ──────────────────────────────────────
  // On each orbit start, re-anchor the OrbitControls target to the surface
  // point at the centre of the screen. The hit lies on the camera view axis,
  // so re-targeting changes the pivot without moving the view.
  const pivotDummy = new THREE.Group();
  pivotDummy.add(new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.85, depthTest: false }),
  ));
  const pivotRing = new THREE.Mesh(
    new THREE.RingGeometry(2.2, 2.6, 32),
    new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.5, depthTest: false, side: THREE.DoubleSide }),
  );
  pivotRing.rotation.x = -Math.PI / 2;
  pivotDummy.add(pivotRing);
  pivotDummy.visible = false;
  scene.add(pivotDummy);

  const $surfaceOrbit = document.getElementById('surfaceOrbit');
  const $showPivot = document.getElementById('showPivot');
  $showPivot.onchange = () => { pivotDummy.visible = $showPivot.checked; };
  $surfaceOrbit.onchange = () => {
    if (!$surfaceOrbit.checked) controls.target.copy(terrain.dataCentre);
  };

  const pivotRay = new THREE.Raycaster();
  const surfacePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pivotHit = new THREE.Vector3();

  function retargetOrbitPivot() {
    pivotRay.setFromCamera({ x: 0, y: 0 }, camera);
    // approximate the displaced surface with a plane at mid displacement height
    surfacePlane.constant = -(terrain.zScale * terrain.zExaggeration * 0.5);
    if (!pivotRay.ray.intersectPlane(surfacePlane, pivotHit)) return;
    if (pivotHit.distanceTo(camera.position) > controls.maxDistance) return;
    controls.target.copy(pivotHit);
    pivotDummy.position.copy(pivotHit);
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!$surfaceOrbit.checked) return;
    if (e.button !== 0 || e.shiftKey || lightSphere.lightMode || measure?.armed) return;
    retargetOrbitPivot();
  }, true); // capture: runs before OrbitControls' own handler

  // ── Controls panel toggle ──────────────────────────────────────────────
  document.getElementById('controlsToggle').onclick = () => {
    document.getElementById('controls').classList.toggle('collapsed');
  };

  // ── UI bindings ───────────────────────────────────────────────────────
  const $hud        = document.getElementById('hud');
  const $sseSlider  = document.getElementById('sseSlider');
  const $sseVal     = document.getElementById('sseVal');
  const $maxSlider  = document.getElementById('maxTilesSlider');
  const $maxVal     = document.getElementById('maxTilesVal');
  const $debugWires = document.getElementById('debugWires');
  const $debugLabels= document.getElementById('debugLabels');
  const $zExag      = document.getElementById('zExagSlider');
  const $zExagVal   = document.getElementById('zExagVal');
  const $axisHelper = document.getElementById('axisHelper');
  const $meshWire   = document.getElementById('meshWire');
  const $animLight  = document.getElementById('animateLight');
  const $splitFloor    = document.getElementById('splitFloorSlider');
  const $splitFloorVal = document.getElementById('splitFloorVal');

  $axisHelper.onchange = () => { axesHelper.visible = $axisHelper.checked; };
  $meshWire.onchange = () => { terrain.setMeshWireframe($meshWire.checked); };
  document.getElementById('tileFade').onchange = (e) => { terrain.setFadeEnabled(e.target.checked); };

  let maxSSE   = +$sseSlider.value;
  let maxTiles = +$maxSlider.value;
  let splitFloorRatio = +$splitFloor.value;

  $sseSlider.oninput = () => { maxSSE = +$sseSlider.value; $sseVal.textContent = maxSSE; };
  $maxSlider.oninput = () => { maxTiles = +$maxSlider.value; $maxVal.textContent = maxTiles; };
  $splitFloor.oninput = () => { splitFloorRatio = +$splitFloor.value; $splitFloorVal.textContent = splitFloorRatio.toFixed(2); };

  const setZExag = (val) => {
    $zExag.value = val;
    $zExagVal.textContent = val.toFixed(1);
    terrain.setZExaggeration(val);
  };

  $zExag.oninput = () => {
    const val = +$zExag.value;
    $zExagVal.textContent = val.toFixed(1);
    terrain.setZExaggeration(val);
    zExagPerField[heightChannel] = val;
  };

  // ── Height field toggle (hidden when the dataset has no height) ───────
  const zExagPerField = { ...DEFAULT_Z_EXAG };
  const radios = document.querySelectorAll('input[name="heightField"]');
  if (heightChannel) {
    for (const radio of radios) {
      radio.checked = radio.value === heightChannel;
      radio.onchange = () => {
        if (!radio.checked) return;
        heightChannel = radio.value;
        terrain.setHeightChannel(heightChannel, metadata.heightFields[heightChannel].zScale);
        setZExag(zExagPerField[heightChannel] ?? 1.0);
      };
    }
  } else if (radios.length) {
    radios[0].closest('.section').style.display = 'none';
  }

  // ── Background + floor grid ───────────────────────────────────────────
  // "Space" is world geometry (gradient dome), the rest are CSS behind the
  // transparent canvas; the dome gets bg-black behind it as a safety net.
  // The checked states in index.html are the source of truth for defaults.
  const dome = createBackgroundDome();
  scene.add(dome);
  const applyBackground = (value) => {
    document.body.classList.remove('bg-flat', 'bg-spotlight', 'bg-black', 'bg-space');
    document.body.classList.add(`bg-${value === 'space' ? 'black' : value}`);
    dome.visible = value === 'space';
  };
  for (const radio of document.querySelectorAll('input[name="background"]')) {
    radio.onchange = () => { if (radio.checked) applyBackground(radio.value); };
  }
  applyBackground(document.querySelector('input[name="background"]:checked').value);
  const $floorGrid = document.getElementById('floorGrid');
  $floorGrid.onchange = () => { grid.visible = $floorGrid.checked; };
  grid.visible = $floorGrid.checked;

  // ── Shadow controls ───────────────────────────────────────────────────
  const $shadowToggle    = document.getElementById('shadowToggle');
  const $shadowBias      = document.getElementById('shadowBias');
  const $shadowBiasVal   = document.getElementById('shadowBiasVal');
  const $shadowIntensity = document.getElementById('shadowIntensity');
  const $shadowIntVal    = document.getElementById('shadowIntensityVal');
  const $shadowSoftness  = document.getElementById('shadowSoftness');
  const $shadowSoftVal   = document.getElementById('shadowSoftnessVal');

  $shadowToggle.onchange = () => { terrain.setShadowEnabled($shadowToggle.checked); };
  const $albedoToggle = document.getElementById('albedoToggle');
  const $albedoButton = document.getElementById('albedoButton');
  const setAlbedo = (on) => {
    terrain.setAlbedoEnabled(on);
    $albedoToggle.checked = on;
    $albedoButton.classList.toggle('active', !on);
  };
  $albedoToggle.onchange = () => setAlbedo($albedoToggle.checked);
  $albedoButton.onclick = () => setAlbedo(!$albedoToggle.checked);
  $shadowBias.oninput = () => {
    const val = +$shadowBias.value;
    $shadowBiasVal.textContent = val.toFixed(4);
    terrain.setShadowBias(val);
  };
  $shadowIntensity.oninput = () => {
    const val = +$shadowIntensity.value;
    $shadowIntVal.textContent = val.toFixed(2);
    terrain.setShadowIntensity(val);
  };
  $shadowSoftness.oninput = () => {
    const val = +$shadowSoftness.value;
    $shadowSoftVal.textContent = val.toFixed(1);
    terrain.setShadowSoftness(val);
  };

  // ── Light toggle (mobile-friendly) ──────────────────────────────────
  $lightToggle.onclick = () => {
    const active = !lightSphere.lightMode;
    lightSphere.lightMode = active;
    $lightToggle.classList.toggle('active', active);
    if (active && measure?.armed) measure.toggle();
    $help.innerHTML = active
      ? 'Drag: light direction'
      : HELP_DEFAULT;
  };

  // ── Main loop ─────────────────────────────────────────────────────────
  let frames = 0, lastT = performance.now(), fps = 0;
  let lightAz = THREE.MathUtils.degToRad(-135);
  let prevLoopT = performance.now();

  function loop() {
    requestAnimationFrame(loop);
    controls.update();

    // keep the pivot dummy at a constant screen size
    pivotDummy.position.copy(controls.target);
    pivotDummy.scale.setScalar(camera.position.distanceTo(controls.target) * 0.008);
    measure?.update();

    const now = performance.now();
    const dt = now - prevLoopT;
    prevLoopT = now;

    // Animate light
    if ($animLight.checked && !lightSphere.isActive) {
      lightAz += dt * 0.0005;
      const el = Math.PI / 4;
      terrain.setLightDir(new THREE.Vector3(
        Math.cos(lightAz) * Math.cos(el),
        Math.sin(el),
        Math.sin(lightAz) * Math.cos(el),
      ).normalize());
    } else if (!$animLight.checked && !lightSphere.isActive) {
      lightAz = lightSphere.azimuth;
    }

    quadTree.update(camera, renderer.domElement.height, maxSSE, maxTiles, splitFloorRatio);
    terrain.update(quadTree.leaves, $debugWires.checked);

    // Shadow pass
    terrain.renderShadowMap(renderer);

    renderer.render(scene, camera);

    frames++;
    if (now - lastT >= 500) {
      fps = Math.round(frames / ((now - lastT) / 1000));
      frames = 0;
      lastT = now;
    }

    if ($debugLabels.checked) {
      const cam = camera.position;
      const polys = terrain.polygons;
      const polysK = polys > 1e6 ? (polys / 1e6).toFixed(1) + 'M' : (polys / 1e3).toFixed(0) + 'K';
      $hud.innerHTML =
        `FPS: <b>${fps}</b><br>` +
        `Tiles: <b>${terrain.count}</b>, Polygons: <b>${polysK}</b><br>` +
        `Source: ${metadata.imageWidth}x${metadata.imageHeight} px (${manifestParam ? 'IIIF manifest' : 'metadata.json'})<br>` +
        `Height field: ${heightChannel ? `${heightChannel} (${metadata.heightFields[heightChannel].heightRangeMM.toFixed(2)} mm)` : 'none (flat)'}<br>` +
        `Nodes: ${quadTree.totalNodes}<br>` +
        `Max depth: ${quadTree.maxLevel}<br>` +
        `Cam: ${cam.x.toFixed(2)}, ${cam.y.toFixed(2)}, ${cam.z.toFixed(2)}<br>` +
        `SSE thr: ${maxSSE}, Split floor: ${splitFloorRatio.toFixed(2)}<br>` +
        `SSE range: ${quadTree.minLeafSSE.toFixed(1)} to ${quadTree.maxLeafSSE.toFixed(1)}<br>` +
        `Streaming: ${terrain.tilesLoaded} loaded, ${terrain.tilesInFlight} pending<br>` +
        `Z exag: ${terrain.zExaggeration.toFixed(1)}×`;
    } else {
      $hud.innerHTML = '';
    }
    $hud.style.display = $debugLabels.checked ? '' : 'none';
  }

  // ── Resize ────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    perspCam.aspect = w / h;
    perspCam.updateProjectionMatrix();
  });

  // debug handle for console inspection
  window.__tactum = { camera, controls, terrain, quadTree };

  loop();
}

init().catch(err => {
  console.error('Could not start the viewer:', err);
  document.body.innerHTML = `<div style="color:red;padding:40px;font-family:monospace">
    <h2>Could not load the dataset</h2>
    <p>${err.message}</p>
    <p>Have you run <code>python scripts/generate_tiles.py</code>?</p>
  </div>`;
});
