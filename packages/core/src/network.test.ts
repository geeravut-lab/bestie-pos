import { describe, expect, it } from 'vitest';
import {
  clearingTotals,
  parsePassScan,
  islandSlugFromPath,
  joinSlugFromPath,
  normalizePassCode,
  parseIsland,
  parsePass,
  passTokenFromPath,
} from './network';

describe('paths and codes', () => {
  it('reads the pass token, join and island slugs, and nothing else', () => {
    expect(passTokenFromPath(`/pass/${'a'.repeat(32)}`)).toBe('a'.repeat(32));
    expect(passTokenFromPath('/pass/short')).toBeNull();
    expect(joinSlugFromPath('/join/koh-phangan')).toBe('koh-phangan');
    expect(joinSlugFromPath('/join/X')).toBeNull();
    expect(islandSlugFromPath('/island/koh-phangan/')).toBe('koh-phangan');
    expect(islandSlugFromPath('/book/abc')).toBeNull();
  });
  it('a pass code is BP- and ten characters; case and spaces are forgiven', () => {
    expect(normalizePassCode(' bp-abcd2345kk ')).toBe('BP-ABCD2345KK');
    expect(normalizePassCode('BP-ABCD2345K0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizePassCode('hello')).toBeNull();
  });
});

describe('parseIsland / parsePass', () => {
  it('reads the shops with their category and booking link, drops broken ones', () => {
    const i = parseIsland({
      network: { slug: 'koh-phangan', name: { th: 'เกาะพะงัน', en: 'Koh Phangan' } },
      shops: [
        {
          category: 'spa',
          title: { th: 'สปา', en: 'Spa' },
          about: { en: 'Sea' },
          booking_token: 'b'.repeat(32),
        },
        { category: 'weird', title: { th: 'ร้าน' }, booking_token: 'nope' },
        { category: 'food', title: {} },
      ],
    });
    expect(i?.shops.length).toBe(2);
    expect(i?.shops[0]).toMatchObject({ category: 'spa', bookingToken: 'b'.repeat(32) });
    expect(i?.shops[1]).toMatchObject({ category: 'other', bookingToken: null });
    expect(parseIsland(null)).toBeNull();
  });
  it('a pass needs a valid code; points and activity are read defensively', () => {
    const p = parsePass({
      name: 'Liu',
      code: 'BP-ABCD2345KK',
      network: { slug: 'x-island', name: { th: 'เกาะ' } },
      points: 10,
      activity: [{ kind: 'earn', points: 5, at: '2026-11-21T00:00:00Z', shop: 'Cafe' }, 7],
    });
    expect(p?.points).toBe(10);
    expect(p?.activity.length).toBe(2);
    expect(parsePass({ code: 'nope' })).toBeNull();
  });
});

describe('clearingTotals', () => {
  it('sums what is owed to the business and what it owes', () => {
    const lines = [
      { issuer: 'A', redeemer: 'B', points: 100, amount: 10000, issuerOrg: 'a', redeemerOrg: 'b' },
      { issuer: 'B', redeemer: 'A', points: 20, amount: 2000, issuerOrg: 'b', redeemerOrg: 'a' },
    ];
    expect(clearingTotals(lines, 'a')).toEqual({ owedToMe: 10000, iOwe: 2000 });
    expect(clearingTotals(lines, 'b')).toEqual({ owedToMe: 2000, iOwe: 10000 });
  });
});

describe('parsePassScan', () => {
  it('takes the printed code or the pass page address, and nothing else', () => {
    const t = 'a'.repeat(32);
    expect(parsePassScan(' bp-abcd2345kk ')).toBe('BP-ABCD2345KK');
    expect(parsePassScan(`https://bestie-pos.vercel.app/pass/${t}`)).toBe(t);
    expect(parsePassScan(`/pass/${t.toUpperCase()}/`)).toBe(t);
    expect(parsePassScan('8850123456789')).toBeNull();
    expect(parsePassScan(`https://evil.example/x/${t}`)).toBeNull();
  });
});
