import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        demo: resolve(__dirname, 'demo/index.html'),
        'example-01': resolve(__dirname, 'examples/01-quadtree-basico/index.html'),
        'example-02': resolve(__dirname, 'examples/02-streaming/index.html'),
        'iiif-mirador': resolve(__dirname, 'examples/iiif-test/index.html'),
        'iiif-osd': resolve(__dirname, 'examples/iiif-test/osd.html'),
        'iiif-uv': resolve(__dirname, 'examples/iiif-test/uv.html'),
      },
    },
  },
});
