import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'jsdom', css: false, setupFiles: ['./src/test-setup.ts'] },
});
