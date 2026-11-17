// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--bp-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m?.[1]) throw new Error(`token --bp-${name} not found as #rrggbb`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme contrast (WCAG AA)', () => {
  // [foreground token, background token, minimum ratio]
  const pairs: [string, string, number][] = [
    ['ink', 'bg', 4.5],
    ['ink', 'surface', 4.5],
    ['muted', 'bg', 4.5],
    ['muted', 'surface', 4.5],
    ['muted', 'mint', 4.5],
    ['on-primary', 'primary', 4.5],
    ['on-primary', 'primary-hover', 4.5],
    ['on-primary', 'primary-pressed', 4.5],
    ['primary', 'surface', 4.5],
    ['primary-hover', 'mint', 4.5], // secondary button hover / selected item
    ['ink', 'brand', 4.5], // bright fills carry ink text only
    ['ink', 'accent', 4.5],
    ['ink', 'sun', 4.5],
    ['ink', 'sky', 4.5],
    ['success-fg', 'success-bg', 4.5],
    ['warning-fg', 'warning-bg', 4.5],
    ['danger-fg', 'danger-bg', 4.5],
    ['on-primary', 'danger-solid', 4.5],
    ['info-fg', 'info-bg', 4.5],
    ['field-border', 'surface', 3], // borders you must see
  ];

  it.each(pairs)('%s on %s >= %f', (fg, bg, min) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(min);
  });

  it('documents the known-bad pairs so nobody "fixes" them the wrong way', () => {
    // Bright brand fills are backgrounds only: white text on them fails.
    expect(contrast(token('on-primary'), token('brand'))).toBeLessThan(4.5);
    expect(contrast(token('on-primary'), token('accent'))).toBeLessThan(4.5);
    // --bp-line is decoration, not a visible border.
    expect(contrast(token('line'), token('surface'))).toBeLessThan(3);
  });
});
