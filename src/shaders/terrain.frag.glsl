// Terrain fragment shader
// Samples albedo texture + Lambertian lighting (directional + ambient)
// with shadow mapping (PCSS + Poisson PCF, slope-scaled bias)

uniform sampler2D albedoMap;
uniform bool albedoEnabled;
uniform vec3 lightDir;
uniform vec3 ambientColor;
uniform vec3 lightColor;
uniform float opacity;
uniform sampler2D shadowMap;
uniform float shadowBias;
uniform float shadowIntensity;
uniform bool shadowEnabled;
uniform float shadowSoftness;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec4 vLightSpacePos;

const vec3 SURFACE_FALLBACK_COLOR = vec3(0.5);

// 16-tap Poisson disk (well-distributed, low discrepancy)
const int POISSON_SAMPLES = 16;
const vec2 poissonDisk[16] = vec2[16](
  vec2(-0.94201624, -0.39906216),
  vec2( 0.94558609, -0.76890725),
  vec2(-0.09418410, -0.92938870),
  vec2( 0.34495938,  0.29387760),
  vec2(-0.91588581,  0.45771432),
  vec2(-0.81544232, -0.87912464),
  vec2(-0.38277543,  0.27676845),
  vec2( 0.97484398,  0.75648379),
  vec2( 0.44323325, -0.97511554),
  vec2( 0.53742981, -0.47373420),
  vec2(-0.26496911, -0.41893023),
  vec2( 0.79197514,  0.19090188),
  vec2(-0.24188840,  0.99706507),
  vec2(-0.81409955,  0.91437590),
  vec2( 0.19984126,  0.78641367),
  vec2( 0.14383161, -0.14100790)
);

// Pseudo-random rotation per pixel to break banding
float pseudoRandom(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// PCSS blocker search: estimate average blocker depth
float findBlockerDepth(vec3 projCoords, float bias, vec2 texelSize, float searchRadius) {
  float blockerSum = 0.0;
  int blockerCount = 0;
  float angle = pseudoRandom(gl_FragCoord.xy) * 6.283185;
  float ca = cos(angle);
  float sa = sin(angle);
  mat2 rot = mat2(ca, sa, -sa, ca);

  for (int i = 0; i < POISSON_SAMPLES; i++) {
    vec2 offset = rot * poissonDisk[i] * searchRadius * texelSize;
    float d = texture2D(shadowMap, projCoords.xy + offset).r;
    if (projCoords.z - bias > d) {
      blockerSum += d;
      blockerCount++;
    }
  }

  if (blockerCount == 0) return -1.0; // no blockers
  return blockerSum / float(blockerCount);
}

void main() {
  vec3 albedo = texture2D(albedoMap, vUv).rgb;
  // Surface only: mid grey, except pure black, which is a masked background
  if (!albedoEnabled && max(albedo.r, max(albedo.g, albedo.b)) > 0.0) albedo = SURFACE_FALLBACK_COLOR;

  vec3 N = normalize(vNormal);
  vec3 L = normalize(lightDir);

  // Lambertian diffuse
  float NdotL = max(dot(N, L), 0.0);

  // Shadow mapping
  float shadowFactor = 1.0;
  if (shadowEnabled) {
    vec3 projCoords = vLightSpacePos.xyz / vLightSpacePos.w;
    projCoords = projCoords * 0.5 + 0.5;

    // Full bounds check including near plane
    if (projCoords.x >= 0.0 && projCoords.x <= 1.0 &&
        projCoords.y >= 0.0 && projCoords.y <= 1.0 &&
        projCoords.z >= 0.0 && projCoords.z <= 1.0) {

      // Slope-scaled bias
      float bias = max(0.0005, shadowBias * (1.0 - NdotL));

      vec2 texelSize = vec2(1.0) / vec2(textureSize(shadowMap, 0));

      float shadow = 0.0;

#ifdef USE_PCSS
      // PCSS: blocker search to determine penumbra size
      float searchRadius = shadowSoftness * 20.0;
      float avgBlockerDepth = findBlockerDepth(projCoords, bias, texelSize, searchRadius);

      if (avgBlockerDepth < 0.0) {
        shadow = 0.0;
      } else {
        float penumbraWidth = (projCoords.z - avgBlockerDepth) / avgBlockerDepth;
        float filterRadius = max(1.0, penumbraWidth * shadowSoftness * 200.0);

        float angle = pseudoRandom(gl_FragCoord.xy) * 6.283185;
        float ca = cos(angle);
        float sa = sin(angle);
        mat2 rot = mat2(ca, sa, -sa, ca);

        for (int i = 0; i < POISSON_SAMPLES; i++) {
          vec2 offset = rot * poissonDisk[i] * filterRadius * texelSize;
          float depth = texture2D(shadowMap, projCoords.xy + offset).r;
          shadow += (projCoords.z - bias > depth) ? 1.0 : 0.0;
        }
        shadow /= float(POISSON_SAMPLES);
      }
#else
      // 8-tap rotated PCF (mobile)
      float angle = pseudoRandom(gl_FragCoord.xy) * 6.283185;
      float ca = cos(angle);
      float sa = sin(angle);
      mat2 rot = mat2(ca, sa, -sa, ca);
      for (int i = 0; i < 8; i++) {
        vec2 offset = rot * poissonDisk[i] * texelSize * 2.0;
        float depth = texture2D(shadowMap, projCoords.xy + offset).r;
        shadow += (projCoords.z - bias > depth) ? 1.0 : 0.0;
      }
      shadow /= 8.0;
#endif

      shadowFactor = 1.0 - shadow * shadowIntensity;
    }
  }

  vec3 diffuse = lightColor * NdotL * shadowFactor;
  vec3 color = albedo * (ambientColor + diffuse);
  gl_FragColor = vec4(color, opacity);
}
