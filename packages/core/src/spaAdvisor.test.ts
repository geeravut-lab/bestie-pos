import { describe, expect, it } from 'vitest';
import {
  EMPTY_SPA_ANSWERS,
  SPA_FLAGS,
  SPA_RULES,
  SPA_TAGS,
  adviseSpa,
  parseSpaInfo,
  spaAdvisorNote,
  tagVerdict,
} from './spaAdvisor';
import type { SpaAnswers, SpaFlag, SpaService, SpaTag } from './spaAdvisor';

const svc = (id: string, ...tags: SpaTag[]): SpaService => ({ id, tags });
const ALL: SpaService[] = SPA_TAGS.map((t) => svc(t, t));
const ans = (over: Partial<SpaAnswers> = {}): SpaAnswers => ({ ...EMPTY_SPA_ANSWERS, ...over });
const ids = (a: ReturnType<typeof adviseSpa>) => a.picks.map((p) => p.id);

describe('spa advisor — safety', () => {
  it('fever or infection: nothing is suggested at all', () => {
    const a = adviseSpa(ans({ goal: 'relax', flags: ['fever_infection', 'pregnant'] }), ALL);
    expect(a).toMatchObject({ safety: 'stop', picks: [] });
  });
  it('pregnancy: no deep stretching, heat or vigorous yoga; the gentle ones come with "ask the therapist"', () => {
    const a = adviseSpa(ans({ flags: ['pregnant'] }), ALL, 20);
    expect(ids(a)).not.toContain('thai_massage');
    expect(ids(a)).not.toContain('hot_compress');
    expect(ids(a)).not.toContain('yoga_flow');
    const oil = a.picks.find((p) => p.id === 'oil_massage');
    expect(oil?.askAbout).toEqual(['pregnant']);
    expect(a.safety).toBe('ask');
  });
  it('clots and blood thinners: no deep Thai massage, no foot massage with clots', () => {
    const a = adviseSpa(ans({ flags: ['clots', 'blood_thinners'] }), ALL, 20);
    expect(ids(a)).not.toContain('thai_massage');
    expect(ids(a)).not.toContain('foot_massage');
    expect(ids(a)).not.toContain('hot_compress');
  });
  it('a skin condition removes the scrub; no flags and no ask means safety ok', () => {
    expect(ids(adviseSpa(ans({ flags: ['skin_condition'] }), ALL, 20))).not.toContain('scrub');
    const a = adviseSpa(ans({ goal: 'relax' }), [svc('x', 'oil_massage')]);
    expect(a.safety).toBe('ok');
  });
  it('a service is dropped when ANY of its tags is avoided (a package of massage + heat for a heart patient)', () => {
    const combo = svc('combo', 'oil_massage', 'hot_compress');
    expect(ids(adviseSpa(ans({ flags: ['heart'] }), [combo, svc('calm', 'meditation')]))).toEqual([
      'calm',
    ]);
  });
  it('a service nobody has tagged is never suggested', () => {
    expect(adviseSpa(ans({ goal: 'relax' }), [svc('mystery')]).picks).toEqual([]);
  });
  it('NEVER offers a service with an avoided tag — checked for every flag combination of up to three flags', () => {
    const flags = [...SPA_FLAGS];
    const combos: SpaFlag[][] = [[]];
    for (const a of flags) {
      combos.push([a]);
      for (const b of flags) if (a < b) combos.push([a, b]);
    }
    for (let i = 0; i < flags.length; i++)
      for (let j = i + 1; j < flags.length; j++)
        for (let k = j + 1; k < flags.length; k++) combos.push([flags[i]!, flags[j]!, flags[k]!]);
    for (const c of combos) {
      const out = adviseSpa(
        ans({ flags: c, goal: 'pain', pressure: 'firm', areas: ['back'] }),
        ALL,
        50,
      );
      for (const p of out.picks) {
        expect(tagVerdict(c, p.id as SpaTag), `${c.join('+')} → ${p.id}`).not.toBe('avoid');
      }
      if (c.includes('fever_infection')) expect(out.picks).toEqual([]);
    }
  });
  it('every rule names a real tag and every tag is judged somewhere or free for all', () => {
    for (const f of SPA_FLAGS)
      for (const t of Object.keys(SPA_RULES[f])) expect(SPA_TAGS).toContain(t);
  });
});

describe('spa advisor — ranking', () => {
  it('goal, pressure and area order the picks; the limit is respected', () => {
    const a = adviseSpa(ans({ goal: 'sleep', pressure: 'light', areas: ['head'] }), ALL, 3);
    expect(a.picks).toHaveLength(3);
    expect(['aromatherapy', 'yoga_restorative', 'meditation', 'head_neck']).toContain(
      a.picks[0]!.id,
    );
    const p = adviseSpa(ans({ goal: 'pain', pressure: 'firm', areas: ['back'] }), ALL, 1);
    expect(['thai_massage', 'hot_compress']).toContain(ids(p)[0]); // equal scores: the first by id
  });
  it('is deterministic: ties are broken by id', () => {
    const a = adviseSpa(ans(), [svc('b', 'oil_massage'), svc('a', 'oil_massage')]);
    expect(ids(a)).toEqual(['a', 'b']);
  });
});

describe('spa advisor — data', () => {
  it('reads the info and drops unknown tags', () => {
    expect(
      parseSpaInfo({
        enabled: true,
        services: [{ id: 's1', tags: ['facial', 'bogus'] }, { nope: 1 }],
      }),
    ).toEqual({
      enabled: true,
      services: [{ id: 's1', tags: ['facial'] }],
    });
    expect(parseSpaInfo(null)).toEqual({ enabled: false, services: [] });
  });
  it('the booking note names only closed flags', () => {
    expect(spaAdvisorNote(['pregnant', 'high_bp'])).toBe(
      'Spa advisor: please check pregnant, high_bp',
    );
    expect(spaAdvisorNote([])).toBe('');
  });
});
