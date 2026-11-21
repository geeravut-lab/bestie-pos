import type { Lang } from './line-messages.js';
import type { LineStore } from './line.js';

/** `LineStore` on Supabase REST with the service-role key. Server only. */
export function createSupabaseLineStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
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
    async bindGuest(code, lineUserId) {
      const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/guest_bind_line`, {
        method: 'POST',
        headers: base,
        body: JSON.stringify({ p_code: code, p_line_user_id: lineUserId }),
      });
      if (!res.ok) return false;
      const out = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      return out?.ok === true;
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
