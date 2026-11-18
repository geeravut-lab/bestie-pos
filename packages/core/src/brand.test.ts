import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRAND_NAME,
  applyBrandNames,
  brandImageUrl,
  brandName,
  brandObjectPath,
  brandToColumn,
  checkFavicon,
  checkLogo,
  detectImageType,
  parseBrand,
  pngSize,
  validBrandName,
} from './brand';

/** A tiny but header-valid PNG of the given size (only the first chunk matters to the checks). */
function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

describe('validBrandName', () => {
  it('accepts 1–40 characters on one line', () => {
    expect(validBrandName('Bestie')).toBe(true);
    expect(validBrandName('ร้านเพื่อนซี้')).toBe(true);
    expect(validBrandName('x'.repeat(40))).toBe(true);
  });
  it('rejects empty, long, multi-line, markup and non-strings', () => {
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\nb', 'a<b', '<script>', 'a\u0000b', 5, null])
      expect(validBrandName(bad), String(bad)).toBe(false);
  });
});

describe('parseBrand / brandToColumn', () => {
  it('reads a valid brand and ignores garbage per field', () => {
    expect(
      parseBrand({
        name_th: 'ไทย',
        name_en: 'Eng',
        logo: { mime: 'image/png', version: 5 },
        favicon: { mime: 'image/svg+xml', version: 1 },
      }),
    ).toEqual({
      nameTh: 'ไทย',
      nameEn: 'Eng',
      logo: { mime: 'image/png', version: 5 },
    });
    expect(parseBrand(null)).toEqual({});
    expect(parseBrand([1])).toEqual({});
    expect(parseBrand({ name_en: '<b>', logo: { mime: 'image/png', version: 'x' } })).toEqual({});
  });
  it('writes only what differs from the default, and round-trips', () => {
    expect(brandToColumn({})).toEqual({});
    expect(brandToColumn({ nameEn: DEFAULT_BRAND_NAME })).toEqual({});
    const b = { nameEn: 'Eng', favicon: { mime: 'image/png' as const, version: 9, size: 512 } };
    expect(parseBrand(brandToColumn(b))).toEqual(b);
  });
  it('falls back to the default name per language', () => {
    expect(brandName('th', { nameEn: 'Eng' })).toBe(DEFAULT_BRAND_NAME);
    expect(brandName('en', { nameEn: 'Eng' })).toBe('Eng');
  });
});

describe('image checks (from bytes, not file names)', () => {
  it('detects PNG / JPEG / WebP and refuses SVG, HTML and unknown data', () => {
    expect(detectImageType(png(10, 10))).toBe('image/png');
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(
      detectImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe('image/webp');
    expect(
      detectImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
    expect(detectImageType(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectImageType(new Uint8Array([]))).toBeNull();
  });
  it('reads PNG dimensions', () => {
    expect(pngSize(png(512, 256))).toEqual({ width: 512, height: 256 });
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it('logo: ≤ 1 MB and a real raster image', () => {
    expect(checkLogo(png(100, 40))).toEqual({ ok: true, mime: 'image/png' });
    expect(checkLogo(png(100, 40, 1024 * 1024))).toEqual({ ok: false, problem: 'too_big' });
    expect(checkLogo(new TextEncoder().encode('<svg/>'))).toEqual({
      ok: false,
      problem: 'bad_type',
    });
  });
  it('tab / app icon: square PNG, 192–1024 px, ≤ 512 KB', () => {
    expect(checkFavicon(png(512, 512))).toEqual({ ok: true, mime: 'image/png', size: 512 });
    expect(checkFavicon(png(192, 192)).ok).toBe(true);
    expect(checkFavicon(png(1024, 1024)).ok).toBe(true);
    expect(checkFavicon(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toEqual({
      ok: false,
      problem: 'not_png',
    });
    expect(checkFavicon(png(512, 300))).toEqual({ ok: false, problem: 'not_square' });
    expect(checkFavicon(png(64, 64))).toEqual({ ok: false, problem: 'too_small' });
    expect(checkFavicon(png(2048, 2048))).toEqual({ ok: false, problem: 'too_large' });
    expect(checkFavicon(png(512, 512, 600 * 1024))).toEqual({ ok: false, problem: 'too_big' });
  });
});

describe('files and URLs', () => {
  it('every upload is a new versioned file', () => {
    expect(brandObjectPath('logo', { mime: 'image/png', version: 1761234567890 })).toBe(
      'logo-1761234567890.png',
    );
    expect(brandObjectPath('favicon', { mime: 'image/webp', version: 2 })).toBe('favicon-2.webp');
    expect(brandImageUrl('logo', { mime: 'image/png', version: 7 })).toBe('/brand/logo?v=7');
    expect(brandImageUrl('logo', undefined)).toBeUndefined();
  });
});

describe('applyBrandNames', () => {
  it('swaps the default name everywhere in one pass', () => {
    expect(
      applyBrandNames('Welcome to Bestie POS — Bestie POS rocks', 'en', { nameEn: 'Island Shop' }),
    ).toBe('Welcome to Island Shop — Island Shop rocks');
  });
  it('does not double-substitute when the new name contains the old one', () => {
    expect(applyBrandNames('Bestie POS', 'en', { nameEn: 'Bestie POS Island' })).toBe(
      'Bestie POS Island',
    );
  });
  it('is a no-op with the default brand and treats $ in names literally', () => {
    expect(applyBrandNames('Bestie POS', 'th', {})).toBe('Bestie POS');
    expect(applyBrandNames('Bestie POS', 'en', { nameEn: 'Cash$&Co' })).toBe('Cash$&Co');
  });
});
