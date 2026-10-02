/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 1420 is fixed by src-tauri/tauri.conf.json (devUrl); strictPort makes a
// clash fail instead of drifting to a port Tauri won't load.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { sourcemap: false },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
