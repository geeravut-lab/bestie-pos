import { parseIsland, parsePass } from '@bestie/core';
import type { Island, Pass } from '@bestie/core';

export type Loaded<T> = { ok: true; data: T } | { ok: false; reason: 'not_found' | 'failed' };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function loadPass(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Loaded<Pass>> {
  try {
    const res = await fetchImpl(`/api/guest/pass?t=${encodeURIComponent(token)}`);
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const pass = parsePass(obj(await res.json().catch(() => null)).pass);
    return pass ? { ok: true, data: pass } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** The "Add to Google Wallet" link of a pass, or null when Google Wallet is not set up (or the request failed). */
export async function loadPassWallet(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`/api/guest/pass-wallet?t=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const b = obj(await res.json().catch(() => null));
    return b.available === true &&
      typeof b.url === 'string' &&
      b.url.startsWith('https://pay.google.com/gp/v/save/')
      ? b.url
      : null;
  } catch {
    return null;
  }
}

export async function loadIsland(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Loaded<Island>> {
  try {
    const res = await fetchImpl(`/api/guest/island?n=${encodeURIComponent(slug)}`);
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const island = parseIsland(obj(await res.json().catch(() => null)).island);
    return island ? { ok: true, data: island } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export type RegisterResult =
  | { ok: true; token: string; code: string }
  | { ok: false; error: 'exists' | 'invalid' | 'consent_needed' | 'not_found' | 'rate' | 'failed' };

export async function registerPass(
  slug: string,
  body: { name: string; phone: string; consent: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<RegisterResult> {
  try {
    const res = await fetchImpl('/api/guest/pass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, ...body }),
    });
    if (res.status === 429) return { ok: false, error: 'rate' };
    const o = obj(await res.json().catch(() => null));
    if (o.ok === true && typeof o.token === 'string' && typeof o.code === 'string')
      return { ok: true, token: o.token, code: o.code };
    const e = String(o.error ?? '');
    if (e === 'exists' || e === 'invalid' || e === 'consent_needed' || e === 'not_found')
      return { ok: false, error: e };
    return { ok: false, error: 'failed' };
  } catch {
    return { ok: false, error: 'failed' };
  }
}
