import { defineConfig, type Plugin } from 'vite';

/** Portal builds (`--mode crazygames` / `--mode poki`) get their own folder, next to the plain web build in dist/. */
const PORTALS = ['crazygames', 'poki'];

/** `npm run dev` also serves the online relay at /relay, so online games work locally. */
const relay = (): Plugin => ({
  name: 'mind-blobs-relay',
  async configureServer(server) {
    if (!server.httpServer) return;
    // Loaded by Node itself (not bundled into the config), like `npm run relay` does.
    // Node keeps modules it has loaded, so restart `npm run dev` after editing server/.
    const { attachRelay } = (await import(new URL('./server/relay.ts', import.meta.url).href)) as typeof import('./server/relay');
    attachRelay(server.httpServer as import('node:http').Server);
  },
});

export default defineConfig(({ mode }) => ({
  plugins: [relay()],
  // Relative asset paths, so the build works from a GitHub Pages subpath (/<repo>/), a portal's CDN, or any folder.
  base: './',
  build: {
    outDir: PORTALS.includes(mode) ? `dist-${mode}` : 'dist',
    // Every file next to index.html, no assets/ folder: some portal uploaders take loose files only.
    assetsDir: '',
  },
}));
