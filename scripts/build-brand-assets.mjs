#!/usr/bin/env node
// Rasterise the default Bestie POS brand (packages/ui/brand/*.svg) into the PNG/ICO files the
// browsers, iOS and Android need, then copy the web set into each app's public/ folder.
//
//   pnpm brand:build
//
// Needs Playwright + Chromium (pre-installed in the cloud sandbox). The generated files are
// committed, so normal builds and CI never need to run this. Re-run it only after editing the SVGs.
//
// These are the *default* brand files. The admin-uploaded brand (BRANDING-KNOWLEDGE.md) overrides
// them at runtime via /brand/logo and /brand/favicon and never touches this folder.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const BRAND = join(ROOT, 'packages/ui/brand');
const APPS = ['pos', 'admin', 'guest'];

const jobs = [
  { svg: 'logo-mark.svg', out: 'icon-192.png', size: 192, transparent: true },
  { svg: 'logo-mark.svg', out: 'icon-512.png', size: 512, transparent: true },
  { svg: 'logo-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  { svg: 'logo-maskable.svg', out: 'apple-touch-icon.png', size: 180 },
  { svg: 'favicon.svg', out: 'favicon-16.png', size: 16, transparent: true },
  { svg: 'favicon.svg', out: 'favicon-32.png', size: 32, transparent: true },
  { svg: 'favicon.svg', out: 'favicon-48.png', size: 48, transparent: true },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const job of jobs) {
  const svg = readFileSync(join(BRAND, job.svg), 'utf8');
  await page.setViewportSize({ width: job.size, height: job.size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${job.size}px;height:${job.size}px}</style>${svg}`,
  );
  await page.screenshot({
    path: join(BRAND, job.out),
    omitBackground: Boolean(job.transparent),
    clip: { x: 0, y: 0, width: job.size, height: job.size },
  });
}
await browser.close();

// favicon.ico = three PNGs wrapped in an ICO container (valid since Windows Vista / all browsers).
const sizes = [16, 32, 48];
const pngs = sizes.map((s) => readFileSync(join(BRAND, `favicon-${s}.png`)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s, 0);
  e.writeUInt8(s, 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
writeFileSync(join(BRAND, 'favicon.ico'), Buffer.concat([header, ...entries, ...pngs]));

const webSet = [
  'favicon.svg',
  'favicon.ico',
  'favicon-32.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];
for (const app of APPS) {
  const dest = join(ROOT, 'apps', app, 'public');
  mkdirSync(dest, { recursive: true });
  for (const f of webSet) copyFileSync(join(BRAND, f), join(dest, f));
}
console.log(`Brand assets built (${jobs.length} PNGs + ICO), copied to ${APPS.length} apps.`);
