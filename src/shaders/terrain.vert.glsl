// Terrain vertex shader
// Decodes 16-bit height from RGB texture, displaces Y, computes normals

uniform sampler2D heightMap;
uniform float zScale;
uniform float zExaggeration;
uniform float tileSize;
uniform mat4 lightMatrix;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec4 vLightSpacePos;

// Decode RGB-encoded 16-bit height to [0, 1] float
float decodeHeight(vec2 uv) {
  vec4 h = texture2D(heightMap, uv);
  // R = high byte, G = low byte
  return (h.r * 255.0 * 256.0 + h.g * 255.0) / 65535.0;
}

void main() {
  vUv = uv;

  // Sample height and displace vertex along Y (up)
  float h = decodeHeight(vUv);
  float displacement = h * zScale * zExaggeration;
  vec3 displaced = position;
  displaced.y += displacement;

  // Compute normals via central differences on the height texture.
  vec2 texelSize = vec2(1.0) / vec2(textureSize(heightMap, 0));
  float hL = decodeHeight(vUv + vec2(-texelSize.x, 0.0));
  float hR = decodeHeight(vUv + vec2( texelSize.x, 0.0));
  float hD = decodeHeight(vUv + vec2(0.0, -texelSize.y));
  float hU = decodeHeight(vUv + vec2(0.0,  texelSize.y));

  float scale = zScale * zExaggeration;
  float worldTexelSize = tileSize * texelSize.x;
  vec3 normal = normalize(vec3(
    (hL - hR) * scale,
    2.0 * worldTexelSize,
    (hU - hD) * scale
  ));

  vNormal = mat3(modelMatrix) * normal;
  vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;

  // Light-space position for shadow mapping
  vLightSpacePos = lightMatrix * modelMatrix * vec4(displaced, 1.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
