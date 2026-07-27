/**
 * Example 01: Basic quadtree
 *
 * Dynamic quadtree with procedural textures.
 * No streaming: each tile generates its texture on the fly with Canvas 2D.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { QuadTree } from '../../src/QuadTree.js';
import { TileRenderer } from '../../src/TileRenderer.js';


// ── Tuning ───────────────────────────────────────────────────────────────
const GRID_CENTER_COLOR = 0x2a2a2a;
const GRID_LINE_COLOR   = 0x1a1a1a;
const CLEAR_COLOR       = 0x0a0a0a;

// ── Renderer ─────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(CLEAR_COLOR);
document.body.appendChild(renderer.domElement);

// ── Cameras ──────────────────────────────────────────────────────────────
const aspect = window.innerWidth / window.innerHeight;

const perspCam = new THREE.PerspectiveCamera(60, aspect, 0.001, 100);
perspCam.position.set(0, 1.2, 0.001);
perspCam.lookAt(0, 0, 0);

let camera = perspCam;

// ── Controls ─────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 0.02;
controls.maxDistance = 5;
controls.maxPolarAngle = Math.PI * 0.48;

// ── Scene ────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();

const grid = new THREE.GridHelper(2, 20, GRID_CENTER_COLOR, GRID_LINE_COLOR);
grid.position.y = -0.002;
scene.add(grid);
scene.add(new THREE.AxesHelper(0.25));

// ── Quadtree + Tile renderer (procedural only) ──────────────────────────
const quadTree = new QuadTree();
const tiles = new TileRenderer(scene, { streaming: false });

// ── UI bindings ──────────────────────────────────────────────────────────
const $hud        = document.getElementById('hud');
const $sseSlider  = document.getElementById('sseSlider');
const $sseVal     = document.getElementById('sseVal');
const $maxSlider  = document.getElementById('maxTilesSlider');
const $maxVal     = document.getElementById('maxTilesVal');
const $debugWires = document.getElementById('debugWires');
const $debugLabels= document.getElementById('debugLabels');
const $splitFloor    = document.getElementById('splitFloorSlider');
const $splitFloorVal = document.getElementById('splitFloorVal');

let maxSSE   = +$sseSlider.value;
let maxTiles = +$maxSlider.value;
let splitFloorRatio = +$splitFloor.value;

$sseSlider.oninput = () => { maxSSE = +$sseSlider.value; $sseVal.textContent = maxSSE; };
$maxSlider.oninput = () => { maxTiles = +$maxSlider.value; $maxVal.textContent = maxTiles; };
$splitFloor.oninput = () => { splitFloorRatio = +$splitFloor.value; $splitFloorVal.textContent = splitFloorRatio.toFixed(2); };
document.getElementById('tileFade').onchange = (e) => { tiles.setFadeEnabled(e.target.checked); };

// ── Main loop ────────────────────────────────────────────────────────────
let frames = 0, lastT = performance.now(), fps = 0;

function loop() {
  requestAnimationFrame(loop);
  controls.update();

  quadTree.update(camera, renderer.domElement.height, maxSSE, maxTiles, splitFloorRatio);
  tiles.update(quadTree.leaves, $debugWires.checked);
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastT >= 500) {
    fps = Math.round(frames / ((now - lastT) / 1000));
    frames = 0;
    lastT = now;
  }

  if ($debugLabels.checked) {
    const cam = camera.position;
    $hud.innerHTML =
      `FPS: <b>${fps}</b><br>` +
      `Tiles: <b>${tiles.count}</b><br>` +
      `Nodes: ${quadTree.totalNodes}<br>` +
      `Max depth: ${quadTree.maxLevel}<br>` +
      `Cam: ${cam.x.toFixed(2)}, ${cam.y.toFixed(2)}, ${cam.z.toFixed(2)}<br>` +
      `SSE thr: ${maxSSE}, Split floor: ${splitFloorRatio.toFixed(2)}<br>` +
      `SSE range: ${quadTree.minLeafSSE.toFixed(1)} to ${quadTree.maxLeafSSE.toFixed(1)}`;
    $hud.style.display = '';
  } else {
    $hud.style.display = 'none';
  }
}

// ── Resize ───────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
});

loop();
