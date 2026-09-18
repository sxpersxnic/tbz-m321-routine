import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// `npm run dev` serves the UI on :5173 (or $PORT) and forwards API calls to the running gateway ($GATEWAY_URL).
// loadEnv instead of process.env: the Docker build has no Node type definitions.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.PORT || 5173),
      proxy: { '/api': env.GATEWAY_URL || 'http://localhost:8080' },
    },
  };
});
