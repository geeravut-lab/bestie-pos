import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildIslandText, handleLineWebhook, isIslandCommand } from './line.js';
import type { IslandListing, LineConfig, LineStore } from './line.js';

const cfg: LineConfig = {
  channelSecret: 's',
  channelAccessToken: 't',
  codeSecret: 'c',
  basicId: '@bestie',
  siteUrl: 'https://bestie-pos.vercel.app/',
};
const B = 'b'.repeat(32);
const O = 'a'.repeat(32);
const island: IslandListing = {
  slug: 'koh-phangan',
  shops: [
    {
      category: 'food',
      title: { th: 'ครัวทะเล', en: 'Sea Kitchen' },
      bookingToken: null,
      orderToken: O,
    },
    { category: 'spa', title: { th: 'สปาป่า' }, bookingToken: B, orderToken: null },
    { category: 'tour', title: { th: 'ทัวร์', en: 'ทัวร์' }, bookingToken: null, orderToken: null },
  ],
};

describe('the island command', () => {
  it('understands the words a guest might type', () => {
    for (const w of ['island', 'ISLAND ', 'เกาะ', 'shops', 'market', 'ตลาดเกาะ', 'ร้านบนเกาะ'])
      expect(isIslandCommand(w)).toBe(true);
    for (const w of ['hello', 'island please', '1A2B3C4D', ''])
      expect(isIslandCommand(w)).toBe(false);
  });
  it('lists every shop in both languages with its booking and order links', () => {
    const text = buildIslandText(island, cfg.siteUrl);
    expect(text).toContain('ร้านบนเกาะ / Shops on the island');
    expect(text).toContain('• ครัวทะเล / Sea Kitchen');
    expect(text).toContain(`สั่งอาหาร / Order food: https://bestie-pos.vercel.app/t/${O}`);
    expect(text).toContain(`จอง / Book: https://bestie-pos.vercel.app/book/${B}`);
    expect(text).toContain('• สปาป่า\n');
    expect(text).toContain('• ทัวร์\n');
    expect(text).toContain('https://bestie-pos.vercel.app/island/koh-phangan');
  });
  it("says so when there are no shops, and never goes over LINE's limit", () => {
    expect(buildIslandText(null, cfg.siteUrl)).toContain('No shops are listed yet.');
    const many: IslandListing = {
      slug: 'x',
      shops: Array.from({ length: 40 }, (_, i) => ({
        category: 'food',
        title: { th: `ร้าน ${i}`, en: 'N'.repeat(100) },
        bookingToken: B,
        orderToken: O,
      })),
    };
    const text = buildIslandText(many, cfg.siteUrl);
    expect(text.length).toBeLessThanOrEqual(4800);
    expect(text.split('•').length - 1).toBe(15);
  });
});

describe('the webhook answers the island command', () => {
  const store = (islandShops?: LineStore['islandShops']): LineStore =>
    ({
      markStopped: async () => {},
      findPendingByHash: async () => null,
      ...(islandShops ? { islandShops } : {}),
    }) as unknown as LineStore;
  const run = async (text: string, st: LineStore) => {
    const body = JSON.stringify({
      events: [
        {
          type: 'message',
          replyToken: 'rt',
          source: { userId: 'U1' },
          message: { type: 'text', text },
        },
      ],
    });
    const reply = vi.fn(async () => {});
    const out = await handleLineWebhook({
      rawBody: body,
      signature: createHmac('sha256', cfg.channelSecret).update(body).digest('base64'),
      cfg,
      store: st,
      reply,
    });
    return { out, reply };
  };
  it('replies with the shops', async () => {
    const { out, reply } = await run(
      'island',
      store(async () => island),
    );
    expect(out.status).toBe(200);
    expect(reply).toHaveBeenCalledTimes(1);
    expect((reply.mock.calls[0] as unknown as [string, string])[1]).toContain('Sea Kitchen');
  });
  it('a failing lookup still answers (with "no shops"), and a store without the feature falls through to the help text', async () => {
    const a = await run(
      'เกาะ',
      store(async () => {
        throw new Error('down');
      }),
    );
    expect((a.reply.mock.calls[0] as unknown as [string, string])[1]).toContain(
      'No shops are listed yet.',
    );
    const b = await run('island', store());
    expect((b.reply.mock.calls[0] as unknown as [string, string])[1]).toContain('island');
  });
});
