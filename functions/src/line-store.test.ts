import { describe, expect, it } from 'vitest';
import { createSupabaseLineStore } from './line-store.js';

/** A tiny fake of the notification_channels REST table: one LINE account may be active for ONE Bestie account (unique index). */
function fakeRest() {
  const rows: {
    id: string;
    owner: string;
    status: string;
    address: string | null;
    last_error?: string;
  }[] = [
    { id: 'old', owner: 'agency', status: 'active', address: 'U-line' },
    { id: 'new', owner: 'admin', status: 'pending', address: null },
  ];
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? 'GET'} ${u.search}`);
    const q = u.searchParams;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const match = rows.filter(
      (r) =>
        (!q.get('id') || r.id === q.get('id')?.replace('eq.', '')) &&
        (!q.get('status') || r.status === q.get('status')?.replace('eq.', '')) &&
        (!q.get('address') || r.address === q.get('address')?.replace('eq.', '')),
    );
    if (init?.method === 'PATCH') {
      if (body.status === 'active') {
        const clash = rows.some((r) => r.status === 'active' && r.address === body.address);
        if (clash) return new Response('{}', { status: 409 });
      }
      match.forEach((r) => Object.assign(r, body));
      return new Response(JSON.stringify(match), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  return { rows, calls, store: createSupabaseLineStore('https://x.test', 'k', fetchImpl) };
}

describe('activate: one LINE account for one Bestie account', () => {
  it('links a LINE account that is free', async () => {
    const { rows, store } = fakeRest();
    rows[0]!.address = 'U-other';
    expect(await store.activate('new', 'U-line')).toBe(true);
    expect(rows[1]).toMatchObject({ status: 'active', address: 'U-line' });
    expect(rows[0]).toMatchObject({ status: 'active', address: 'U-other' });
  });

  it('moves the link from the old account when the same LINE account proves it holds the new code', async () => {
    const { rows, store } = fakeRest();
    expect(await store.activate('new', 'U-line')).toBe(true);
    expect(rows[1]).toMatchObject({ status: 'active', address: 'U-line' });
    expect(rows[0]).toMatchObject({ status: 'stopped', last_error: 'moved' });
    expect(rows.filter((r) => r.status === 'active' && r.address === 'U-line')).toHaveLength(1);
  });

  it('does nothing for a channel that is no longer pending', async () => {
    const { rows, store } = fakeRest();
    rows[1]!.status = 'stopped';
    expect(await store.activate('new', 'U-free')).toBe(false);
  });
});
