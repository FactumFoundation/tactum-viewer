// Environment dome: a large inward-facing sphere with a subtle vertical
// gradient of desaturated blue-blacks. It is world geometry, not CSS, so it
// moves with the camera and gives a sense of space around the piece.
// Dithered to avoid banding on the very dark gradient.

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec3 vDir;

// Desaturated blue-black palette
const vec3 ZENITH  = vec3(0.012, 0.016, 0.031);  // near-black blue overhead
const vec3 HORIZON = vec3(0.055, 0.075, 0.106);  // muted slate blue at eye level
const vec3 NADIR   = vec3(0.008, 0.010, 0.016);  // darkest below the floor

// tiny per-pixel dither so the dark gradient doesn't band
float dither(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453) / 255.0;
}

void main() {
  float y = vDir.y;  // -1 nadir … 0 horizon … +1 zenith
  vec3 color = y >= 0.0
    ? mix(HORIZON, ZENITH, pow(y, 0.55))
    : mix(HORIZON, NADIR, pow(-y, 0.7));
  color += dither(gl_FragCoord.xy);
  gl_FragColor = vec4(color, 1.0);
}
`;

/** Inward-facing gradient dome. Add to the scene; toggle via .visible. */
export function createBackgroundDome(radius = 50) {
  const geo = new THREE.SphereGeometry(radius, 48, 32);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = 'background-dome';
  dome.renderOrder = -1;      // paint first, behind everything
  dome.frustumCulled = false; // always surrounds the camera
  dome.visible = false;
  return dome;
}
