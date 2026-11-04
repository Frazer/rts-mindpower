import { defineConfig } from 'vite';

/** Portal builds (`--mode crazygames` / `--mode poki`) get their own folder, next to the plain web build in dist/. */
const PORTALS = ['crazygames', 'poki'];

export default defineConfig(({ mode }) => ({
  // Relative asset paths, so the build works from a GitHub Pages subpath (/<repo>/), a portal's CDN, or any folder.
  base: './',
  build: {
    outDir: PORTALS.includes(mode) ? `dist-${mode}` : 'dist',
  },
}));
