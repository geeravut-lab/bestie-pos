import type { LocalizedText } from './types';

/** One information card the shop wrote (wifi, opening hours, check-out, island tips…). The guest always reads the shop's own words. */
export type InfoCard = { id: string; title: LocalizedText; body: LocalizedText };

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): LocalizedText | null => {
  if (!isRec(v) || typeof v.th !== 'string' || v.th.trim() === '') return null;
  return {
    th: v.th.slice(0, max),
    ...(typeof v.en === 'string' && v.en.trim() !== '' ? { en: v.en.slice(0, max) } : {}),
  };
};

export function parseInfoCards(raw: unknown): InfoCard[] {
  if (!Array.isArray(raw)) return [];
  const out: InfoCard[] = [];
  for (const c of raw.slice(0, 40)) {
    if (!isRec(c) || typeof c.id !== 'string') continue;
    const title = text(c.title, 80);
    const body = text(c.body, 1000);
    if (title && body) out.push({ id: c.id, title, body });
  }
  return out;
}

/**
 * What the model answered, reduced to cards that really exist. The model is shown a NUMBERED list and may only answer with numbers;
 * anything else (an unknown number, a duplicate, text) is dropped, so a guest can only ever be shown a card the shop wrote.
 */
export function pickInfoCards(answer: unknown, cards: readonly InfoCard[]): InfoCard[] {
  const ids = isRec(answer) && Array.isArray(answer.ids) ? answer.ids : [];
  const out: InfoCard[] = [];
  for (const n of ids) {
    const card = typeof n === 'number' && Number.isInteger(n) ? cards[n - 1] : undefined;
    if (card && !out.includes(card)) out.push(card);
    if (out.length === 3) break;
  }
  return out;
}

export const FEEDBACK_TOPICS = ['food', 'service', 'place', 'price', 'other'] as const;
export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];
export type FeedbackRow = {
  id: string;
  rating: number;
  topic: FeedbackTopic;
  comment: string | null;
  handled: boolean;
  createdAt: string;
  tableName: string | null;
};

export function parseFeedback(raw: unknown): FeedbackRow[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedbackRow[] = [];
  for (const r of raw) {
    if (!isRec(r) || typeof r.id !== 'string' || typeof r.rating !== 'number') continue;
    const t = r.dining_tables;
    const table = Array.isArray(t) ? t[0] : t;
    out.push({
      id: r.id,
      rating: Math.min(5, Math.max(1, Math.round(r.rating))),
      topic: (FEEDBACK_TOPICS as readonly unknown[]).includes(r.topic)
        ? (r.topic as FeedbackTopic)
        : 'other',
      comment: typeof r.comment === 'string' && r.comment !== '' ? r.comment : null,
      handled: r.handled === true,
      createdAt: typeof r.created_at === 'string' ? r.created_at : '',
      tableName: isRec(table) && typeof table.name === 'string' ? table.name : null,
    });
  }
  return out;
}

/** Average rating and how many are still open, for the top of the feedback screen. */
export function feedbackSummary(rows: readonly FeedbackRow[]): {
  count: number;
  average: number | null;
  open: number;
} {
  if (rows.length === 0) return { count: 0, average: null, open: 0 };
  const sum = rows.reduce((a, r) => a + r.rating, 0);
  return {
    count: rows.length,
    average: Math.round((sum / rows.length) * 10) / 10,
    open: rows.filter((r) => !r.handled && r.rating <= 2).length,
  };
}
