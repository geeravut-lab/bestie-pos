import type { SupabaseClient } from '@supabase/supabase-js';

/** "/stock/insights" → "stock_insights"; ids in the path (uuids, numbers) are dropped so a screen is counted, never a record. */
export function pageName(path: string): string {
  const parts = path
    .split('/')
    .filter((p) => p && !/^[0-9a-f-]{8,}$/i.test(p) && !/^\d+$/.test(p))
    .slice(0, 2)
    .map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return (parts.join('_') || 'home').slice(0, 40);
}

const seenKey = (day: string) => `bestie-usage:${day}`;
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * Usage analytics of our own: once a day per person ("active") and once a day per screen ("page_view" with the screen's name).
 * No content, no outside SDK; the browser remembers what it already sent today so a busy screen does not call the server again.
 */
export function trackPage(client: SupabaseClient | null, path: string): void {
  if (!client) return;
  const day = today();
  let seen: string[];
  try {
    seen = JSON.parse(globalThis.localStorage?.getItem(seenKey(day)) ?? '[]') as string[];
  } catch {
    seen = [];
  }
  const todo: { event: 'active' | 'page_view'; detail: string | null; key: string }[] = [];
  if (!seen.includes('active')) todo.push({ event: 'active', detail: null, key: 'active' });
  const page = pageName(path);
  if (!seen.includes(`p:${page}`))
    todo.push({ event: 'page_view', detail: page, key: `p:${page}` });
  if (todo.length === 0) return;
  try {
    globalThis.localStorage?.setItem(
      seenKey(day),
      JSON.stringify([...seen, ...todo.map((t) => t.key)]),
    );
  } catch {
    /* private window: it just counts again next time (the database ignores repeats) */
  }
  for (const t of todo)
    void client.rpc('track_event', { p_event: t.event, p_detail: t.detail }).then(
      () => {},
      () => {},
    );
}
