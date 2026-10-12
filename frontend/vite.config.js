import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const backendUrl = process.env.VITE_BACKEND_URL || process.env.BACKEND_URL || 'http://localhost:3001';

const handleProxyError = (proxy) => {
  proxy.on('error', (err, req, res) => {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, isRunning: false, stage: 'idle', offline: true }));
    }
  });
};

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api/zoho-health': {
        target: 'https://zoho-mail-reader.onrender.com',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/api/bot': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/submissions': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/auth': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/operators': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/admin': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/stats': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/clients': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api/zoho-health': {
        target: 'https://zoho-mail-reader.onrender.com',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/api/bot': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/submissions': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/auth': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/operators': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/admin': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/stats': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
      '/api/clients': {
        target: backendUrl,
        changeOrigin: true,
        configure: handleProxyError,
      },
    },
  },
});

