import { build } from 'vite';
import { globSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const root = '/home/user/bestie-pos/apps/pos';
const files = globSync('api/**/*.ts', { cwd: root });
const input = Object.fromEntries(files.map((f) => [f.replace(/\.ts$/, ''), resolve(root, f)]));
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: true,
    outDir: '/tmp/api-dist',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      input,
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
      },
    },
  },
});
console.log('built', files.length);
