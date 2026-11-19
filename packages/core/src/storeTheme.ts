/**
 * Per-shop colours: the owner picks FIVE colours and nothing else; every pairing that carries text is checked against WCAG AA
 * before it can be saved (the same rules packages/ui/src/theme.test.ts keeps for the built-in palette).
 *
 *   primary  buttons and links     white text on it >= 4.5, and it as text on a white surface >= 4.5
 *   brand    bright fill           ink text on it >= 4.5   (never white: bright fills are backgrounds only)
 *   accent   bright fill           ink text on it >= 4.5
 *   sun      bright fill           ink text on it >= 4.5
 *   mint     soft tint behind text ink and muted text on it >= 4.5, and the hover colour of primary on it >= 4.5
 *
 * The fixed colours (ink, muted, white, surface) are NOT in this file — the colour tokens live only in theme.css — so the
 * checks receive them from the caller (the page reads them from the live stylesheet).
 */

export const THEME_KEYS = ['primary', 'brand', 'accent', 'sun', 'mint'] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];
export type StoreTheme = Partial<Record<ThemeKey, string>>;

const HEX6 = /^#[0-9a-f]{6}$/i;
export const isHex6 = (v: unknown): v is string => typeof v === 'string' && HEX6.test(v);

/** Reads the `stores.theme` column: only the five keys with #rrggbb values survive. */
export function parseTheme(raw: unknown): StoreTheme {
  const out: StoreTheme = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of THEME_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (isHex6(v)) out[k] = v.toLowerCase();
    }
  }
  return out;
}

const channel = (hex: string, i: number): number => parseInt(hex.slice(i, i + 2), 16);
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = channel(hex, i) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `from` moved `t` (0..1) of the way towards `to`. */
export function mixHex(from: string, to: string, t: number): string {
  const c = (i: number) =>
    Math.round(channel(from, i) * (1 - t) + channel(to, i) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${c(1)}${c(3)}${c(5)}`;
}

/** The colours the theme does not choose. */
export type FixedColours = { ink: string; muted: string; white: string; surface: string };

export type ThemeProblem = { key: ThemeKey; pair: string; ratio: number; min: number };

/** The hover / pressed shades of primary are derived (towards ink), never chosen. */
export const primaryHover = (primary: string, ink: string): string => mixHex(primary, ink, 0.25);
export const primaryPressed = (primary: string, ink: string): string => mixHex(primary, ink, 0.4);

/** Every rule the chosen colours break (empty = safe to save). Colours not chosen fall back to the built-in palette and are not checked. */
export function themeProblems(theme: StoreTheme, fixed: FixedColours): ThemeProblem[] {
  const out: ThemeProblem[] = [];
  const check = (key: ThemeKey, pair: string, a: string, b: string, min = 4.5) => {
    const ratio = contrastRatio(a, b);
    if (ratio < min) out.push({ key, pair, ratio: Math.round(ratio * 100) / 100, min });
  };
  if (theme.primary) {
    check('primary', 'white on primary', fixed.white, theme.primary);
    check('primary', 'primary on surface', theme.primary, fixed.surface);
    check('primary', 'white on primary hover', fixed.white, primaryHover(theme.primary, fixed.ink));
  }
  for (const k of ['brand', 'accent', 'sun'] as const)
    if (theme[k]) check(k, `ink on ${k}`, fixed.ink, theme[k]);
  if (theme.mint) {
    check('mint', 'ink on mint', fixed.ink, theme.mint);
    check('mint', 'muted on mint', fixed.muted, theme.mint);
    const p = theme.primary;
    if (p) check('mint', 'primary hover on mint', primaryHover(p, fixed.ink), theme.mint);
  }
  return out;
}

/** CSS custom properties to put on the document for this theme (only the colours the owner chose). */
export function themeVars(theme: StoreTheme, ink: string): Record<string, string> {
  const v: Record<string, string> = {};
  if (theme.primary) {
    v['--bp-primary'] = theme.primary;
    if (isHex6(ink)) {
      v['--bp-primary-hover'] = primaryHover(theme.primary, ink);
      v['--bp-primary-pressed'] = primaryPressed(theme.primary, ink);
    }
  }
  if (theme.brand) v['--bp-brand'] = theme.brand;
  if (theme.accent) v['--bp-accent'] = theme.accent;
  if (theme.sun) v['--bp-sun'] = theme.sun;
  if (theme.mint) v['--bp-mint'] = theme.mint;
  return v;
}
