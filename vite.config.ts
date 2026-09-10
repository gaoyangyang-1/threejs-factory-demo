import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vue: ['vue', 'pinia'],
          three: ['three']
        }
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 放行 Cloudflare Quick Tunnel 等内网穿透域名，避免 Vite Host 校验 403
    allowedHosts: ['.trycloudflare.com', '.lhr.life', '.localtunnel.me']
  }
});
