import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = Number(process.env.LT_PORT) || 8787;
// LT_HTTPS=1 serves the UI over self-signed HTTPS so a second device on the LAN can use its mic.
const https = process.env.LT_HTTPS === '1';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss(), ...(https ? [basicSsl()] : [])],
  server: {
    port: Number(process.env.LT_WEB_PORT) || 5174,
    strictPort: true,
    host: process.env.LT_WEB_HOST || '127.0.0.1',
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
