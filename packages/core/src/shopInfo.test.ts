import { describe, expect, it } from 'vitest';
import { feedbackSummary, parseFeedback, parseInfoCards, pickInfoCards } from './shopInfo';

const cards = parseInfoCards([
  { id: 'a', title: { th: 'ไวไฟ', en: 'Wifi' }, body: { th: 'รหัส 1234' } },
  { id: 'b', title: { th: 'เวลาเปิด' }, body: { th: '8-22' } },
  { id: 'c', title: { th: 'เช็คเอาต์' }, body: { th: '11:00' } },
  { id: 'd', title: { th: 'ขนส่ง' }, body: { th: 'แท็กซี่' } },
  { id: 'bad', title: { th: '' }, body: { th: 'x' } },
  'nope',
]);

describe('info cards', () => {
  it('keeps only well-formed cards', () => {
    expect(cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(cards[0]!.title).toEqual({ th: 'ไวไฟ', en: 'Wifi' });
    expect(parseInfoCards(null)).toEqual([]);
  });
  it('turns the model’s numbers into real cards only: unknown, duplicate or non-number answers are dropped, at most 3', () => {
    expect(pickInfoCards({ ids: [2, 1] }, cards).map((c) => c.id)).toEqual(['b', 'a']);
    expect(pickInfoCards({ ids: [9, 0, -1, 1.5, '2', 2, 2] }, cards).map((c) => c.id)).toEqual([
      'b',
    ]);
    expect(pickInfoCards({ ids: [1, 2, 3, 4] }, cards)).toHaveLength(3);
    expect(pickInfoCards('wifi password is 1234', cards)).toEqual([]);
    expect(pickInfoCards({ ids: 'a' }, cards)).toEqual([]);
  });
});

describe('feedback', () => {
  const rows = parseFeedback([
    {
      id: '1',
      rating: 5,
      topic: 'food',
      comment: 'yum',
      handled: false,
      created_at: 't',
      dining_tables: { name: 'T1' },
    },
    {
      id: '2',
      rating: 1,
      topic: 'weird',
      comment: '',
      handled: false,
      created_at: 't',
      dining_tables: [{ name: 'T2' }],
    },
    { id: '3', rating: 2, topic: 'service', comment: null, handled: true, created_at: 't' },
    { nope: true },
  ]);
  it('is read defensively', () => {
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ topic: 'other', comment: null, tableName: 'T2' });
  });
  it('summarises the average and the low ratings still open', () => {
    expect(feedbackSummary(rows)).toEqual({ count: 3, average: 2.7, open: 1 });
    expect(feedbackSummary([])).toEqual({ count: 0, average: null, open: 0 });
  });
});
