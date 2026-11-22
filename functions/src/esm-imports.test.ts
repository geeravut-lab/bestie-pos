import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vercel runs the API functions as plain Node ESM: a relative import WITHOUT a ".js" ending cannot be found at run time
 * ("ERR_MODULE_NOT_FOUND ... packages/core/src/csv imported from growth.js"), even though the editor, Vitest and the build are happy.
 * This walks every file the API entry points can reach and fails on a value import that lacks the ending.
 */
const ROOT = resolve(__dirname, '../..');
const API = join(ROOT, 'apps/pos/api');

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const IMPORT =
  /(^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveSpec(from: string, spec: string): { file: string; hasExt: boolean } | null {
  const target = resolve(dirname(from), spec);
  if (spec.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx']) {
      const c = target.replace(/\.js$/, ext);
      if (existsSync(c)) return { file: c, hasExt: true };
    }
    return null;
  }
  for (const c of [`${target}.ts`, `${target}.tsx`, join(target, 'index.ts')])
    if (existsSync(c)) return { file: c, hasExt: false };
  return null;
}

describe('API functions only use relative imports Node can resolve', () => {
  it('has no value import without a .js ending in anything reachable from apps/pos/api', () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(IMPORT)) {
        const isType = Boolean(m[3]);
        const r = resolveSpec(file, m[5]!);
        if (!r || isType) continue; // type-only imports are erased
        if (!r.hasExt) bad.push(`${file.replace(`${ROOT}/`, '')} imports '${m[5]}'`);
        visit(r.file);
      }
    };
    for (const entry of listTs(API)) visit(entry);
    expect(seen.size).toBeGreaterThan(50); // the walk really reached the functions and core
    expect(bad).toEqual([]);
  });
});
