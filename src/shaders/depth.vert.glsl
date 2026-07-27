// Depth pass vertex shader
// Must replicate exact same displacement as terrain.vert.glsl
// so shadow map geometry matches the visible terrain.

uniform sampler2D heightMap;
uniform float zScale;
uniform float zExaggeration;

varying vec2 vUv;

float decodeHeight(vec2 uv) {
  vec4 h = texture2D(heightMap, uv);
  return (h.r * 255.0 * 256.0 + h.g * 255.0) / 65535.0;
}

void main() {
  vUv = uv;

  float h = decodeHeight(vUv);
  float displacement = h * zScale * zExaggeration;
  vec3 displaced = position;
  displaced.y += displacement;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
