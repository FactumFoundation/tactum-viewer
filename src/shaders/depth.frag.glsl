// Depth pass fragment shader
// Depth is written automatically to the depth buffer by WebGL.
// We only need a minimal fragment shader.

void main() {
  gl_FragColor = vec4(1.0);
}
