import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

const FASTAPI_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8088';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: FASTAPI_TARGET,
          changeOrigin: true,
        },
        '/uploads': {
          target: FASTAPI_TARGET,
          changeOrigin: true,
        },
        '/images': {
          target: FASTAPI_TARGET,
          changeOrigin: true,
        },
      },
    },
  };
});
