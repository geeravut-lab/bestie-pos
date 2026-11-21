// Hair-style advisor (salon): the shop's catalogue plus the guest's four closed answers → which styles suit. Plain code, no AI:
// nothing the guest types or uploads is read by a model, and the photo never leaves the database except to the stylist.
import type { LocalizedText } from './types';

export const HAIR_LENGTHS = ['short', 'medium', 'long'] as const;
export const HAIR_TEXTURES = ['straight', 'wavy', 'curly'] as const;
export const HAIR_FACES = ['oval', 'round', 'square', 'heart'] as const;
export const HAIR_UPKEEP = ['low', 'medium', 'high'] as const;
export type HairLength = (typeof HAIR_LENGTHS)[number];
export type HairTexture = (typeof HAIR_TEXTURES)[number];
export type HairFace = (typeof HAIR_FACES)[number];
export type HairUpkeep = (typeof HAIR_UPKEEP)[number];

export type HairStyle = {
  id: string;
  name: LocalizedText;
  about: { th?: string; en?: string } | null;
  lengths: HairLength[];
  textures: HairTexture[];
  faces: HairFace[];
  upkeep: HairUpkeep | null;
};

/** What the guest says; `any` / `unknown` / missing = no preference. */
export type HairAnswers = {
  length?: HairLength | 'any';
  texture?: HairTexture | 'any';
  face?: HairFace | 'unknown';
  upkeep?: HairUpkeep | 'any';
};

const pick = <T extends string>(all: readonly T[], v: unknown): T[] =>
  Array.isArray(v)
    ? v.filter((x): x is T => typeof x === 'string' && (all as readonly string[]).includes(x))
    : [];
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The catalogue as the server sends it; anything malformed is dropped. */
export function parseHairStyles(raw: unknown): HairStyle[] {
  if (!Array.isArray(raw)) return [];
  const out: HairStyle[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const name = r.name as { th?: unknown; en?: unknown } | null;
    if (typeof r.id !== 'string' || !name || text(name.th) === '') continue;
    const about = r.about as { th?: unknown; en?: unknown } | null;
    out.push({
      id: r.id,
      name: { th: text(name.th), ...(text(name.en) ? { en: text(name.en) } : {}) },
      about: about ? { th: text(about.th) || undefined, en: text(about.en) || undefined } : null,
      lengths: pick(HAIR_LENGTHS, r.lengths),
      textures: pick(HAIR_TEXTURES, r.textures),
      faces: pick(HAIR_FACES, r.faces),
      upkeep: (HAIR_UPKEEP as readonly string[]).includes(text(r.upkeep))
        ? (r.upkeep as HairUpkeep)
        : null,
    });
  }
  return out;
}

const rank = (u: HairUpkeep): number => HAIR_UPKEEP.indexOf(u);

/**
 * Styles that suit the answers, best first. Length and texture are hard rules (a style that does not list the guest's length /
 * texture is left out; a style that lists none suits all). Upkeep is a ceiling (never more upkeep than the guest wants). The face
 * shape only ranks: a match scores, a mismatch scores down. Ties keep the shop's own order.
 */
export function adviseStyles(
  styles: readonly HairStyle[],
  a: HairAnswers,
  max = 4,
): { style: HairStyle; score: number }[] {
  const out: { style: HairStyle; score: number; i: number }[] = [];
  styles.forEach((style, i) => {
    let score = 0;
    if (a.length && a.length !== 'any' && style.lengths.length > 0) {
      if (!style.lengths.includes(a.length)) return;
      score += 2;
    }
    if (a.texture && a.texture !== 'any' && style.textures.length > 0) {
      if (!style.textures.includes(a.texture)) return;
      score += 2;
    }
    if (a.upkeep && a.upkeep !== 'any' && style.upkeep) {
      if (rank(style.upkeep) > rank(a.upkeep)) return;
      score += 1;
    }
    if (a.face && a.face !== 'unknown' && style.faces.length > 0)
      score += style.faces.includes(a.face) ? 2 : -1;
    out.push({ style, score, i });
  });
  return out
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, max)
    .map(({ style, score }) => ({ style, score }));
}

/** The body of `save_hair_style` (staff). */
export function hairStylePayload(input: {
  id?: string;
  storeId: string;
  nameTh: string;
  nameEn: string;
  aboutTh: string;
  aboutEn: string;
  lengths: readonly HairLength[];
  textures: readonly HairTexture[];
  faces: readonly HairFace[];
  upkeep: HairUpkeep | '';
}): Record<string, unknown> | null {
  const th = input.nameTh.trim();
  if (th === '' || th.length > 80 || input.aboutTh.length > 200 || input.aboutEn.length > 200)
    return null;
  return {
    ...(input.id ? { id: input.id } : {}),
    store_id: input.storeId,
    name: { th, ...(input.nameEn.trim() ? { en: input.nameEn.trim() } : {}) },
    about:
      input.aboutTh.trim() || input.aboutEn.trim()
        ? { th: input.aboutTh.trim(), en: input.aboutEn.trim() }
        : null,
    lengths: [...input.lengths],
    textures: [...input.textures],
    faces: [...input.faces],
    upkeep: input.upkeep || null,
  };
}
