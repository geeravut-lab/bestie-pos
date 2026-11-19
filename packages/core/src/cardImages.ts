import { detectImageType } from './brand';
import type { BrandImageMime } from './brand';

/** Admin-uploaded replacements for the home-card illustrations (docs/UX-DESIGN.md §7). */
export type CardImage = { mime: BrandImageMime; version: number };
export type CardImages = Record<string, CardImage>;

export const CARD_IMAGE_MAX_BYTES = 1024 * 1024;
const ID = /^[a-zA-Z]{2,20}$/;

export function parseCardImages(raw: unknown): CardImages {
  const out: CardImages = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const o = v as { mime?: unknown; version?: unknown } | null;
      if (
        ID.test(k) &&
        o &&
        (o.mime === 'image/png' || o.mime === 'image/jpeg' || o.mime === 'image/webp') &&
        typeof o.version === 'number' &&
        Number.isFinite(o.version)
      )
        out[k] = { mime: o.mime, version: o.version };
    }
  }
  return out;
}

export type CardImageProblem = 'too_big' | 'bad_type';
export function checkCardImage(
  bytes: Uint8Array,
): { ok: true; mime: BrandImageMime } | { ok: false; problem: CardImageProblem } {
  if (bytes.length > CARD_IMAGE_MAX_BYTES) return { ok: false, problem: 'too_big' };
  const mime = detectImageType(bytes);
  return mime ? { ok: true, mime } : { ok: false, problem: 'bad_type' };
}

const EXT: Record<BrandImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const cardObjectPath = (id: string, image: CardImage): string =>
  `${id}-${image.version}.${EXT[image.mime]}`;
export const cardImageUrl = (id: string, image: CardImage | undefined): string | undefined =>
  image ? `/api/card-image?id=${encodeURIComponent(id)}&v=${image.version}` : undefined;
export const cardImageUrls = (images: CardImages): Record<string, string> =>
  Object.fromEntries(Object.entries(images).map(([id, im]) => [id, cardImageUrl(id, im)!]));
