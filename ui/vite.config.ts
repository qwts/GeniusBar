/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The App guide (#287) is imported from the Genius soul's own package,
// one directory up, so the dev server and tests may read that package.
const guide = decodeURIComponent(new URL('../souls/starter.soul', import.meta.url).pathname);

// Port 1420 is fixed by src-tauri/tauri.conf.json (devUrl); strictPort makes a
// clash fail instead of drifting to a port Tauri won't load.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: ['.', guide] } },
  build: { sourcemap: false },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['src/test-setup.ts'] },
});
