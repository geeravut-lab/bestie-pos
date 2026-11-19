import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  mixHex,
  parseTheme,
  primaryHover,
  themeProblems,
  themeVars,
} from './storeTheme';
import type { FixedColours } from './storeTheme';

const fixed: FixedColours = {
  ink: '#0f2d4a',
  muted: '#4f6577',
  white: '#ffffff',
  surface: '#ffffff',
};

describe('parseTheme', () => {
  it('keeps the five keys with #rrggbb values only, lower-cased', () => {
    expect(
      parseTheme({
        primary: '#00796F',
        brand: 'teal',
        accent: '#ff7a59',
        sun: 12,
        mint: '#d5f7f0',
        extra: '#000000',
      }),
    ).toEqual({ primary: '#00796f', accent: '#ff7a59', mint: '#d5f7f0' });
    expect(parseTheme(null)).toEqual({});
    expect(parseTheme([])).toEqual({});
  });
});

describe('contrast helpers', () => {
  it('black on white is 21, equal colours are 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });
  it('mixHex moves towards the target', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#102030', '#102030', 0.3)).toBe('#102030');
  });
});

describe('themeProblems', () => {
  it('the built-in palette passes', () => {
    expect(
      themeProblems(
        {
          primary: '#00796f',
          brand: '#2bd4bf',
          accent: '#ff7a59',
          sun: '#ffcb3d',
          mint: '#d5f7f0',
        },
        fixed,
      ),
    ).toEqual([]);
  });
  it('an empty theme has nothing to check', () => {
    expect(themeProblems({}, fixed)).toEqual([]);
  });
  it('a pale primary fails: white text on it and it as text on white', () => {
    const p = themeProblems({ primary: '#7fd1c8' }, fixed);
    expect(p.map((x) => x.pair)).toEqual(
      expect.arrayContaining(['white on primary', 'primary on surface']),
    );
    expect(p.every((x) => x.ratio < x.min)).toBe(true);
  });
  it('a dark bright-fill fails: ink text needs a light fill', () => {
    expect(themeProblems({ accent: '#7a1f12' }, fixed).map((x) => x.pair)).toEqual([
      'ink on accent',
    ]);
    expect(themeProblems({ sun: '#101010' }, fixed)[0]!.key).toBe('sun');
  });
  it('a dark mint fails for ink and muted text', () => {
    const pairs = themeProblems({ mint: '#1c4d6b' }, fixed).map((x) => x.pair);
    expect(pairs).toEqual(expect.arrayContaining(['ink on mint', 'muted on mint']));
  });
  it('mint is also checked against the derived hover colour of the chosen primary', () => {
    // a mid-dark primary whose hover is not readable on a mid mint
    const p = themeProblems({ primary: '#00796f', mint: '#5fb7ab' }, fixed).map((x) => x.pair);
    expect(p).toContain('primary hover on mint');
  });
});

describe('themeVars', () => {
  it('writes only what was chosen; primary also brings its derived shades', () => {
    expect(themeVars({}, fixed.ink)).toEqual({});
    expect(themeVars({ sun: '#ffcb3d' }, fixed.ink)).toEqual({ '--bp-sun': '#ffcb3d' });
    const v = themeVars({ primary: '#00796f' }, fixed.ink);
    expect(v['--bp-primary']).toBe('#00796f');
    expect(v['--bp-primary-hover']).toBe(primaryHover('#00796f', fixed.ink));
    expect(Object.keys(v)).toHaveLength(3);
  });
});
