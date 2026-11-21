import { describe, expect, it } from 'vitest';
import { adviseStyles, hairStylePayload, parseHairStyles } from './hairAdvisor';
import type { HairStyle } from './hairAdvisor';

const st = (id: string, over: Partial<HairStyle> = {}): HairStyle => ({
  id,
  name: { th: id },
  about: null,
  lengths: [],
  textures: [],
  faces: [],
  upkeep: null,
  ...over,
});

describe('adviseStyles', () => {
  const bob = st('bob', {
    lengths: ['short', 'medium'],
    textures: ['straight'],
    faces: ['oval', 'heart'],
    upkeep: 'low',
  });
  const layers = st('layers', { lengths: ['long'], upkeep: 'high' });
  const any = st('any');

  it('length and texture are hard rules; a style that lists none suits all', () => {
    const r = adviseStyles([bob, layers, any], { length: 'long' }).map((x) => x.style.id);
    expect(r).toEqual(['layers', 'any'].filter((x) => r.includes(x)));
    expect(r).not.toContain('bob');
    expect(adviseStyles([bob], { texture: 'curly' })).toEqual([]);
  });
  it('upkeep is a ceiling', () => {
    expect(adviseStyles([layers, bob], { upkeep: 'low' }).map((x) => x.style.id)).toEqual(['bob']);
    expect(adviseStyles([layers, bob], { upkeep: 'high' }).length).toBe(2);
  });
  it('the face shape ranks: a match first, a mismatch last, nothing is hidden by it', () => {
    const round = st('round', { faces: ['round'] });
    const r = adviseStyles([round, bob], { face: 'oval' }).map((x) => x.style.id);
    expect(r).toEqual(['bob', 'round']);
  });
  it('"any" / "unknown" / nothing means no preference; ties keep the shop order; at most max', () => {
    expect(adviseStyles([bob, layers, any], {}).map((x) => x.style.id)).toEqual([
      'bob',
      'layers',
      'any',
    ]);
    expect(adviseStyles([bob, layers, any], { length: 'any', face: 'unknown' }, 2).length).toBe(2);
  });
});

describe('parseHairStyles', () => {
  it('keeps valid styles, drops unknown tags and malformed rows', () => {
    const r = parseHairStyles([
      {
        id: 'a',
        name: { th: 'บ๊อบ', en: 'Bob' },
        lengths: ['short', 'tiny'],
        textures: 'x',
        faces: ['oval'],
        upkeep: 'low',
        about: { en: 'hi' },
      },
      { id: 'b', name: {} },
      null,
    ]);
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({
      lengths: ['short'],
      textures: [],
      faces: ['oval'],
      upkeep: 'low',
    });
    expect(parseHairStyles('x')).toEqual([]);
  });
});

describe('hairStylePayload', () => {
  const base = {
    storeId: 's',
    nameTh: ' บ๊อบ ',
    nameEn: '',
    aboutTh: '',
    aboutEn: '',
    lengths: ['short'] as const,
    textures: [] as const,
    faces: [] as const,
    upkeep: '' as const,
  };
  it('trims, leaves out an empty English name and description', () => {
    expect(hairStylePayload(base)).toMatchObject({
      store_id: 's',
      name: { th: 'บ๊อบ' },
      about: null,
      upkeep: null,
      lengths: ['short'],
    });
  });
  it('refuses a missing or too long name', () => {
    expect(hairStylePayload({ ...base, nameTh: ' ' })).toBeNull();
    expect(hairStylePayload({ ...base, aboutEn: 'x'.repeat(201) })).toBeNull();
  });
});
