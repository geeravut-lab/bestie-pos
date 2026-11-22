import type { Lang } from './line-messages.js';
import type { LineStore } from './line.js';

/** `LineStore` on Supabase REST with the service-role key. Server only. */
export function createSupabaseLineStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
  islandSlug = 'koh-phangan',
): LineStore {
  const base = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
  const rest = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: { ...base, ...(init.headers ?? {}) },
    });
  const rows = async <T>(res: Response): Promise<T[]> => {
    if (!res.ok) throw new Error(`rest ${res.status}`);
    return (await res.json()) as T[];
  };

  return {
    async islandShops() {
      const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/guest_island`, {
        method: 'POST',
        headers: base,
        body: JSON.stringify({ p_slug: islandSlug }),
      });
      if (!res.ok) return null;
      const out = (await res.json().catch(() => null)) as {
        shops?: {
          category?: unknown;
          title?: { th?: unknown; en?: unknown };
          booking_token?: unknown;
          order_token?: unknown;
        }[];
      } | null;
      if (!out || !Array.isArray(out.shops)) return null;
      const tok = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null);
      return {
        slug: islandSlug,
        shops: out.shops.flatMap((s) =>
          typeof s.title?.th === 'string' && s.title.th
            ? [
                {
                  category: String(s.category ?? 'other'),
                  title: {
                    th: s.title.th,
                    ...(typeof s.title.en === 'string' && s.title.en ? { en: s.title.en } : {}),
                  },
                  bookingToken: tok(s.booking_token),
                  orderToken: tok(s.order_token),
                },
              ]
            : [],
        ),
      };
    },
    async bindGuest(code, lineUserId) {
      const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/guest_bind_line`, {
        method: 'POST',
        headers: base,
        body: JSON.stringify({ p_code: code, p_line_user_id: lineUserId }),
      });
      if (!res.ok) return false;
      const out = (await res.json().catch(() => null)) as { ok?: unknown; kind?: unknown } | null;
      if (out?.ok !== true) return false;
      return out.kind === 'marketing' ? 'marketing' : true;
    },
    async stopMarketing(lineUserId) {
      const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/marketing_stop`, {
        method: 'POST',
        headers: base,
        body: JSON.stringify({ p_line_user_id: lineUserId }),
      });
      if (!res.ok) return 0;
      const n: unknown = await res.json().catch(() => 0);
      return typeof n === 'number' ? n : 0;
    },
    async startLink(userId, codeHash, expiresAt) {
      const res = await rest('notification_channels?on_conflict=owner_id,channel', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          owner_id: userId,
          channel: 'line',
          status: 'pending',
          address: null,
          code_hash: codeHash,
          code_expires_at: expiresAt.toISOString(),
          attempts: 0,
          last_error: null,
          verified_at: null,
        }),
      });
      if ((await rows(res)).length !== 1) throw new Error('startLink wrote no row'); // an upsert that touches no row is not a success
    },
    async findPendingByHash(codeHash) {
      const r = await rows<{
        id: string;
        owner_id: string;
        code_expires_at: string;
        attempts: number;
      }>(
        await rest(
          `notification_channels?select=id,owner_id,code_expires_at,attempts&channel=eq.line&status=eq.pending&code_hash=eq.${encodeURIComponent(codeHash)}&limit=1`,
        ),
      );
      const x = r[0];
      return x
        ? {
            id: x.id,
            ownerId: x.owner_id,
            expiresAt: new Date(x.code_expires_at),
            attempts: x.attempts,
          }
        : null;
    },
    async activate(id, lineUserId) {
      const res = await rest(
        `notification_channels?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            address: lineUserId,
            status: 'active',
            code_hash: null,
            code_expires_at: null,
            verified_at: new Date().toISOString(),
            last_error: null,
          }),
        },
      );
      if (res.status === 409) return false; // that LINE account is already active for another user
      return (await rows(res)).length === 1;
    },
    async markStopped(lineUserId, reason) {
      await rest(
        `notification_channels?channel=eq.line&address=eq.${encodeURIComponent(lineUserId)}&status=eq.active`,
        { method: 'PATCH', body: JSON.stringify({ status: 'stopped', last_error: reason }) },
      );
    },
    async status(userId) {
      const r = await rows<{
        status: 'pending' | 'active' | 'stopped';
        code_expires_at: string | null;
        last_error: string | null;
      }>(
        await rest(
          `notification_channels?select=status,code_expires_at,last_error&owner_id=eq.${encodeURIComponent(userId)}&channel=eq.line&limit=1`,
        ),
      );
      const x = r[0];
      return x ? { status: x.status, expiresAt: x.code_expires_at, lastError: x.last_error } : null;
    },
    async activeAddress(userId) {
      const r = await rows<{ address: string | null }>(
        await rest(
          `notification_channels?select=address&owner_id=eq.${encodeURIComponent(userId)}&channel=eq.line&status=eq.active&limit=1`,
        ),
      );
      return r[0]?.address ?? null;
    },
    async remove(userId) {
      const res = await rest(
        `notification_channels?owner_id=eq.${encodeURIComponent(userId)}&channel=eq.line`,
        { method: 'DELETE', headers: { Prefer: 'return=representation' } },
      );
      return (await rows(res)).length === 1;
    },
    async log(e) {
      await rest('message_log', {
        method: 'POST',
        body: JSON.stringify({
          owner_id: e.ownerId,
          channel: 'line',
          kind: e.kind,
          status: e.status,
          error: e.error ?? null,
        }),
      });
    },
    async ownerLang(ownerId) {
      const r = await rows<{ language: string }>(
        await rest(`profiles?select=language&user_id=eq.${encodeURIComponent(ownerId)}&limit=1`),
      );
      return (r[0]?.language === 'en' ? 'en' : 'th') as Lang;
    },
  };
}
