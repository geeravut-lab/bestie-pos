#!/usr/bin/env node
// Repo conventions that ESLint cannot express. Run via `pnpm check:conventions` (part of `pnpm lint`).
//
//  1. No hex / rgb() colours in source — every colour is a token from packages/ui/src/theme.css
//     (docs/UX-DESIGN.md §4; TYPOGRAPHY-COLOR-KNOWLEDGE.md §5.4).
//  2. No Thai literals in .ts/.tsx — every user-facing string lives in packages/i18n
//     (I18N-KNOWLEDGE.md §4.1; CLAUDE.md rule 8).
//  3. Server-only secrets never get a client-exposed prefix (SSO-Aivora-Supabase.md).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vercel', 'coverage']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const rel = (f) => relative(ROOT, f).split(sep).join('/');
const isTest = (r) => /\.(test|spec)\.(ts|tsx)$/.test(r);

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?![\w-])/;
const COLOR_FN = /\b(?:rgb|rgba|hsl|hsla)\(\s*\d/;
const THAI = /[฀-๿]/;
const SECRET_PREFIX =
  /\b(?:VITE|NEXT_PUBLIC|PUBLIC)_[A-Z0-9_]*(?:SERVICE_ROLE|SECRET|PRIVATE)[A-Z0-9_]*/;

const problems = [];
const add = (file, line, msg) => problems.push(`${file}:${line}  ${msg}`);

for (const file of walk(ROOT)) {
  const r = rel(file);
  const isCode = /\.(ts|tsx|css)$/.test(r);
  const isSource = /\.(ts|tsx)$/.test(r);
  if (!isCode && !/\.(js|mjs|json|html|ya?ml|example)$/.test(r) && !r.endsWith('.env.example'))
    continue;

  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // 3. secrets with a public prefix — checked everywhere except this script and docs.
  if (r !== 'scripts/check-conventions.mjs' && !isTest(r)) {
    lines.forEach((l, i) => {
      if (SECRET_PREFIX.test(l))
        add(r, i + 1, 'secret-looking variable has a client-exposed prefix');
    });
  }

  // 1. colours: only theme.css may contain them (and tests that verify contrast).
  // functions/src/brand.ts: the web manifest needs literal hex values (kept equal to the theme tokens by a unit test).
  if (isCode && r !== 'packages/ui/src/theme.css' && r !== 'functions/src/brand.ts' && !isTest(r)) {
    lines.forEach((l, i) => {
      if (HEX.test(l) || COLOR_FN.test(l)) add(r, i + 1, 'raw colour value — use a theme token');
    });
  }

  // 2. Thai literals in source: only the dictionary and tests may contain them.
  if (isSource && r !== 'packages/i18n/src/dict.ts' && !isTest(r)) {
    lines.forEach((l, i) => {
      if (THAI.test(l)) add(r, i + 1, 'Thai text in code — put it in packages/i18n/src/dict.ts');
    });
  }
}

if (problems.length) {
  console.error(
    `Convention check failed (${problems.length}):\n` + problems.map((p) => '  ' + p).join('\n'),
  );
  process.exit(1);
}
console.log('Convention check passed.');
