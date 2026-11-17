import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Absolute asset paths: nested routes such as /sso/callback must never resolve assets relatively
  // (docs/SSO-Aivora-Supabase.md, step 1).
  base: '/',
  // One shared .env.local at the repo root (see docs/ENVIRONMENT.md).
  envDir: '../..',
  server: { port: 5173 },
  test: { environment: 'jsdom', css: false },
});
