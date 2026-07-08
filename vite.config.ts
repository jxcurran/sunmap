import { defineConfig } from 'vite';

// NFR-4.4 CSP is normally a server-set header; for this static build we mirror it
// via <meta> in index.html since there is no first-party backend (see README).
export default defineConfig({
  base: '/sunmap/',
  build: {
    target: 'es2022'
  },
});
