import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLEX_COLORS,
  FLEX_LIMITS,
  LINK_ALPHABET,
  appLink,
  buildFlexMessage,
  linkCodeFromBytes,
  noticeBody,
  parseLinkMessage,
  parseNotice,
  safeInternalPath,
  truncate,
} from './flex';

const site = 'https://bestie-pos.vercel.app';
const bodyOf = (m: ReturnType<typeof buildFlexMessage>) =>
  (m.contents as { body: { contents: Record<string, unknown>[] } }).body.contents;
const buttonOf = (m: ReturnType<typeof buildFlexMessage>) =>
  (
    m.contents as {
      footer: { contents: { color: string; action: { label: string; uri: string } }[] };
    }
  ).footer.contents[0]!;

describe('truncate', () => {
  it('keeps short text and cuts long text with an ellipsis, by code point', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('😀😀😀😀😀😀', 3)).toBe('😀😀…'); // never half an emoji
    expect(truncate('  a \n b  ', 20)).toBe('a b');
  });
});

describe('notice text ↔ card', () => {
  it('stores summary + "label: value" lines and reads them back', () => {
    const body = noticeBody('Paid by PromptPay', [
      { label: 'Bill', value: 'A-102' },
      { label: 'Total', value: '฿275' },
    ]);
    expect(body).toBe('Paid by PromptPay\nBill: A-102\nTotal: ฿275');
    expect(parseNotice('Payment received', body)).toEqual({
      title: 'Payment received',
      summary: 'Paid by PromptPay',
      lines: [
        { label: 'Bill', value: 'A-102' },
        { label: 'Total', value: '฿275' },
      ],
    });
  });
  it('does not mistake a URL for a label', () => {
    expect(parseNotice('t', 'https://example.com/x').lines).toEqual([]);
  });
  it('understands the Thai colon too', () => {
    expect(parseNotice('t', 'ยอดรวม： 275').lines).toEqual([{ label: 'ยอดรวม', value: '275' }]);
  });
});

describe('buildFlexMessage', () => {
  const notice = {
    title: 'Payment received',
    summary: 'Bill A-102 is paid',
    lines: [
      { label: 'Total', value: 'THB 275' },
      { label: 'Method', value: 'PromptPay' },
    ],
  };

  it('is one bubble: title, summary, label/value rows, and one "open app" button', () => {
    const m = buildFlexMessage({
      notice,
      openLabel: 'Open the app',
      siteUrl: site,
      path: '/orders',
    });
    expect(m.type).toBe('flex');
    expect(bodyOf(m)).toHaveLength(4); // title + summary + 2 rows
    expect(bodyOf(m)[0]).toMatchObject({
      text: 'Payment received',
      weight: 'bold',
      color: FLEX_COLORS.title,
    });
    expect(buttonOf(m).action).toEqual({
      type: 'uri',
      label: 'Open the app',
      uri: `${site}/orders?openExternalBrowser=1`,
    });
  });

  it('altText carries the whole story (it is what the lock screen shows)', () => {
    const m = buildFlexMessage({ notice, openLabel: 'Open', siteUrl: site });
    expect(m.altText).toBe(
      'Payment received — Bill A-102 is paid — Total THB 275 — Method PromptPay',
    );
  });

  it('enforces every length limit even for absurd input', () => {
    const huge = {
      title: 'T'.repeat(500),
      summary: 'S'.repeat(2000),
      lines: Array.from({ length: 20 }, (_, i) => ({
        label: `L${i}`.repeat(30),
        value: 'V'.repeat(500),
      })),
    };
    const m = buildFlexMessage({ notice: huge, openLabel: 'O'.repeat(60), siteUrl: site });
    expect([...m.altText].length).toBeLessThanOrEqual(FLEX_LIMITS.altText);
    const body = bodyOf(m);
    expect(body.length).toBeLessThanOrEqual(1 + FLEX_LIMITS.lines); // title + at most 8 detail lines (summary counts as one)
    expect([...(body[0] as { text: string }).text].length).toBeLessThanOrEqual(FLEX_LIMITS.title);
    expect([...(body[1] as { text: string }).text].length).toBeLessThanOrEqual(FLEX_LIMITS.text);
    const row = (body[2] as { contents: { text: string }[] }).contents;
    expect([...row[0]!.text].length).toBeLessThanOrEqual(FLEX_LIMITS.label);
    expect([...row[1]!.text].length).toBeLessThanOrEqual(FLEX_LIMITS.value);
    expect([...buttonOf(m).action.label].length).toBeLessThanOrEqual(FLEX_LIMITS.button);
  });

  it('works without a summary or rows', () => {
    const m = buildFlexMessage({ notice: { title: 'Hi' }, openLabel: 'Open', siteUrl: site });
    expect(bodyOf(m)).toHaveLength(1);
    expect(m.altText).toBe('Hi');
  });
});

describe('links never leave our site', () => {
  it('accepts only internal paths', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      'javascript:alert(1)',
      '',
      'orders',
      '/a\\b',
      undefined,
      5,
    ])
      expect(safeInternalPath(bad), String(bad)).toBe('/');
    expect(safeInternalPath('/orders/42?x=1')).toBe('/orders/42?x=1');
  });
  it('appends openExternalBrowser correctly and tolerates a trailing slash on the site URL', () => {
    expect(appLink(`${site}/`, '/orders')).toBe(`${site}/orders?openExternalBrowser=1`);
    expect(appLink(site, '/orders?id=1')).toBe(`${site}/orders?id=1&openExternalBrowser=1`);
    expect(appLink(site, 'https://evil.example')).toBe(`${site}/?openExternalBrowser=1`);
  });
});

describe('colours match the theme tokens (a Flex JSON cannot use CSS variables)', () => {
  it('title, text, label and button colours equal theme.css', () => {
    const css = readFileSync(join(import.meta.dirname, '../../ui/src/theme.css'), 'utf8');
    const token = (n: string) =>
      new RegExp(`--bp-${n}:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1]!.toLowerCase();
    expect(FLEX_COLORS.title).toBe(token('primary-hover'));
    expect(FLEX_COLORS.text).toBe(token('ink'));
    expect(FLEX_COLORS.label).toBe(token('muted'));
    expect(FLEX_COLORS.button).toBe(token('primary'));
  });
});

describe('link codes', () => {
  it('has 32 symbols and no look-alike characters', () => {
    expect(LINK_ALPHABET).toHaveLength(32);
    expect(LINK_ALPHABET).not.toMatch(/[01OI]/);
  });
  it('turns random bytes into an 8-character code from the alphabet (no modulo bias)', () => {
    expect(linkCodeFromBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBe('ABCDEFGH');
    expect(linkCodeFromBytes(new Uint8Array([255, 254, 253, 252, 251, 250, 249, 248]))).toBe(
      '98765432',
    );
    expect(() => linkCodeFromBytes(new Uint8Array(4))).toThrow();
    for (let i = 0; i < 50; i++)
      expect(linkCodeFromBytes(crypto.getRandomValues(new Uint8Array(8)))).toMatch(
        /^[A-HJ-NP-Z2-9]{8}$/,
      );
  });
  it('accepts the code alone or after "LINK", any case, and nothing else', () => {
    expect(parseLinkMessage('abcd2345')).toBe('ABCD2345');
    for (const ch of LINK_ALPHABET) expect(parseLinkMessage(ch.repeat(8)), ch).toBe(ch.repeat(8)); // every symbol of the alphabet is accepted
    expect(parseLinkMessage('  LINK abcd2345 ')).toBe('ABCD2345');
    for (const bad of [
      'hello',
      'ABCD234',
      'ABCD23456',
      'ABCD0345',
      'ABCDI345',
      'link',
      'ABCD2345 please',
      '',
    ])
      expect(parseLinkMessage(bad), bad).toBeNull();
  });
});
