/**
 * Admin-controlled brand: product name (TH / EN), logo and tab/app icon (docs/BRANDING-KNOWLEDGE.md).
 * Stored in `platform_settings.brand` as ONLY what differs from the defaults; `{}` = Bestie's own name and artwork.
 *
 * Rules enforced here: names 1–40 chars, one line, no `<` `>` or control characters (they end up in <title>, the web
 * manifest and LINE messages); images are checked from their BYTES (never the file extension), SVG is never accepted,
 * the tab icon must be a square PNG 192–1024 px (it is also the installed-app icon).
 */
export const DEFAULT_BRAND_NAME = 'Bestie POS';

export const BRAND_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type BrandImageMime = (typeof BRAND_IMAGE_MIMES)[number];
export type BrandImageKind = 'logo' | 'favicon';

export type BrandImage = {
  mime: BrandImageMime;
  /** upload time (ms) — also the ETag / cache-buster */ version: number;
  size?: number;
};
export type Brand = { nameTh?: string; nameEn?: string; logo?: BrandImage; favicon?: BrandImage };

export const LOGO_MAX_BYTES = 1024 * 1024;
export const FAVICON_MAX_BYTES = 512 * 1024;
export const FAVICON_MIN_PX = 192;
export const FAVICON_MAX_PX = 1024;

/** One name for the UI: 1–40 chars, single line, nothing that could break HTML or a message. */
export function validBrandName(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 1 || t.length > 40) return false;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (ch === '<' || ch === '>' || c < 0x20 || c === 0x7f) return false; // markup and control characters
  }
  return true;
}

const isMime = (v: unknown): v is BrandImageMime =>
  (BRAND_IMAGE_MIMES as readonly unknown[]).includes(v);

function parseImage(raw: unknown): BrandImage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (!isMime(o.mime) || typeof o.version !== 'number' || !Number.isFinite(o.version))
    return undefined;
  const size = typeof o.size === 'number' && Number.isInteger(o.size) ? o.size : undefined;
  return { mime: o.mime, version: o.version, ...(size ? { size } : {}) };
}

/** Generous: a missing / malformed field falls back to the default. A broken row must never break every page. */
export function parseBrand(raw: unknown): Brand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: Brand = {};
  if (validBrandName(o.name_th)) out.nameTh = o.name_th.trim();
  if (validBrandName(o.name_en)) out.nameEn = o.name_en.trim();
  const logo = parseImage(o.logo);
  if (logo) out.logo = logo;
  const favicon = parseImage(o.favicon);
  if (favicon) out.favicon = favicon;
  return out;
}

/** Inverse of parseBrand: write only what differs from the defaults. */
export function brandToColumn(b: Brand): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.nameTh && b.nameTh !== DEFAULT_BRAND_NAME) out.name_th = b.nameTh.trim();
  if (b.nameEn && b.nameEn !== DEFAULT_BRAND_NAME) out.name_en = b.nameEn.trim();
  if (b.logo)
    out.logo = {
      mime: b.logo.mime,
      version: b.logo.version,
      ...(b.logo.size ? { size: b.logo.size } : {}),
    };
  if (b.favicon)
    out.favicon = {
      mime: b.favicon.mime,
      version: b.favicon.version,
      ...(b.favicon.size ? { size: b.favicon.size } : {}),
    };
  return out;
}

export const brandName = (lang: 'th' | 'en', b: Brand): string =>
  (lang === 'th' ? b.nameTh : b.nameEn) ?? DEFAULT_BRAND_NAME;

// ── images, judged from their bytes ────────────────────────────────────────
export function detectImageType(bytes: Uint8Array): BrandImageMime | null {
  const b = bytes;
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp';
  return null; // includes SVG / HTML / anything else
}

/** Width × height from the PNG IHDR header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (detectImageType(bytes) !== 'image/png' || bytes.length < 24) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(12) !== 0x49484452) return null; // "IHDR" must be the first chunk
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export type ImageProblem =
  'too_big' | 'bad_type' | 'not_png' | 'not_square' | 'too_small' | 'too_large';

export function checkLogo(
  bytes: Uint8Array,
): { ok: true; mime: BrandImageMime } | { ok: false; problem: ImageProblem } {
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, problem: 'too_big' };
  const mime = detectImageType(bytes);
  return mime ? { ok: true, mime } : { ok: false, problem: 'bad_type' };
}

export function checkFavicon(
  bytes: Uint8Array,
): { ok: true; mime: 'image/png'; size: number } | { ok: false; problem: ImageProblem } {
  if (bytes.length > FAVICON_MAX_BYTES) return { ok: false, problem: 'too_big' };
  if (detectImageType(bytes) !== 'image/png') return { ok: false, problem: 'not_png' };
  const dim = pngSize(bytes);
  if (!dim) return { ok: false, problem: 'not_png' };
  if (dim.width !== dim.height) return { ok: false, problem: 'not_square' };
  if (dim.width < FAVICON_MIN_PX) return { ok: false, problem: 'too_small' };
  if (dim.width > FAVICON_MAX_PX) return { ok: false, problem: 'too_large' };
  return { ok: true, mime: 'image/png', size: dim.width };
}

const EXT: Record<BrandImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
/** A new upload is a NEW file with a new version; an existing file is never overwritten (caches would go stale). */
export const brandObjectPath = (kind: BrandImageKind, image: BrandImage): string =>
  `${kind}-${image.version}.${EXT[image.mime]}`;
export const brandImageUrl = (
  kind: BrandImageKind,
  image: BrandImage | undefined,
): string | undefined => (image ? `/brand/${kind}?v=${image.version}` : undefined);

/**
 * Swap the default product name for the admin's name in ONE pass. Doing it name by name would turn a new name that
 * contains the old one ("Bestie POS Island") into "Bestie POS Island Island"-style duplicates.
 */
export function applyBrandNames(text: string, lang: 'th' | 'en', brand: Brand): string {
  const name = brandName(lang, brand);
  if (name === DEFAULT_BRAND_NAME) return text;
  return text.replace(
    new RegExp(DEFAULT_BRAND_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    () => name,
  );
}
