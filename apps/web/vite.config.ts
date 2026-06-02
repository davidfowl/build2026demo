import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_BASE_URL ?? 'http://localhost:4310';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    open: false,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
