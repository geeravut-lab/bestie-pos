/**
 * LINE account linking + push (docs/LINE-ACCOUNT-LINKING-KNOWLEDGE.md), server side. Everything that talks to the outside
 * world (the database, LINE, randomness, time) is injected so the whole flow is unit-tested.
 *
 * Flow: signed-in user → startLineLink (one-time code, only its HMAC is stored, 30 min) → user sends the code to the LINE
 * Official Account → webhook (signature verified over the RAW body) → bindLine (looked up by HASH) → reply in the owner's language.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  LINK_CODE_TTL_MINUTES,
  LINK_MAX_ATTEMPTS,
  buildFlexMessage,
  linkCodeFromBytes,
  parseLinkMessage,
} from '../../packages/core/src/flex.js';
import type { Notice } from '../../packages/core/src/flex.js';
import { LINE_MESSAGES, helpBothLanguages } from './line-messages.js';
import type { Lang } from './line-messages.js';

export type LineConfig = {
  channelSecret: string;
  channelAccessToken: string;
  /** HMAC key for link codes (separate from the channel secret). */
  codeSecret: string;
  basicId: string;
  siteUrl: string;
};

export interface LineStore {
  /** Create or OVERWRITE the user's pending link (a new request kills the old code immediately). */
  startLink(userId: string, codeHash: string, expiresAt: Date): Promise<void>;
  findPendingByHash(
    codeHash: string,
  ): Promise<{ id: string; ownerId: string; expiresAt: Date; attempts: number } | null>;
  /** Must only succeed while the row is still `pending` (one winner if two messages race). */
  activate(id: string, lineUserId: string): Promise<boolean>;
  markStopped(lineUserId: string, reason: string): Promise<void>;
  status(userId: string): Promise<{
    status: 'pending' | 'active' | 'stopped';
    expiresAt: string | null;
    lastError: string | null;
  } | null>;
  activeAddress(userId: string): Promise<string | null>;
  remove(userId: string): Promise<boolean>;
  log(entry: {
    ownerId: string | null;
    kind: string;
    status: 'sent' | 'failed';
    error?: string;
  }): Promise<void>;
  ownerLang(ownerId: string): Promise<Lang>;
}

export const hashCode = (secret: string, code: string): string =>
  createHmac('sha256', secret).update(code).digest('hex');

export async function startLineLink(
  store: LineStore,
  userId: string,
  cfg: Pick<LineConfig, 'codeSecret' | 'basicId'>,
  now: Date = new Date(),
  random: (n: number) => Uint8Array = randomBytes,
) {
  const code = linkCodeFromBytes(random(8));
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MINUTES * 60_000);
  await store.startLink(userId, hashCode(cfg.codeSecret, code), expiresAt);
  return { code, expiresAt: expiresAt.toISOString(), basicId: cfg.basicId }; // the code is shown ONCE; only its hash is stored
}

export async function bindLine(
  store: LineStore,
  code: string,
  lineUserId: string,
  cfg: Pick<LineConfig, 'codeSecret'>,
  now: Date = new Date(),
): Promise<{ ok: true; ownerId: string } | { ok: false }> {
  if (!lineUserId || !parseLinkMessage(code)) return { ok: false };
  const row = await store.findPendingByHash(hashCode(cfg.codeSecret, code.trim().toUpperCase()));
  if (!row || row.expiresAt.getTime() <= now.getTime() || row.attempts >= LINK_MAX_ATTEMPTS)
    return { ok: false };
  const won = await store.activate(row.id, lineUserId); // `where status = 'pending'` and exactly one row must change
  return won ? { ok: true, ownerId: row.ownerId } : { ok: false };
}

// ── webhook ─────────────────────────────────────────────────────────────────
export function verifyLineSignature(
  rawBody: string,
  secret: string,
  signature: string | null,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected); // length first: timingSafeEqual throws otherwise
}

/** Sliding-window limiter, per LINE user (slows code guessing from one account). In memory = per instance. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}

type LineEvent = {
  type?: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { type?: string; text?: string };
};
export type Reply = (replyToken: string, text: string) => Promise<void>;

export async function handleLineWebhook(args: {
  rawBody: string;
  signature: string | null;
  cfg: LineConfig;
  store: LineStore;
  reply: Reply;
  allow?: (key: string) => boolean;
  now?: Date;
}): Promise<{ status: number; body: { ok?: true; error?: string } }> {
  const { rawBody, signature, cfg, store, reply } = args;
  const allow = args.allow ?? (() => true);
  if (rawBody.length > 200_000) return { status: 413, body: { error: 'too_large' } };
  if (!verifyLineSignature(rawBody, cfg.channelSecret, signature))
    return { status: 401, body: { error: 'bad_signature' } };

  let parsed: { events?: LineEvent[] };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'bad_json' } };
  }
  for (const ev of (parsed.events ?? []).slice(0, 20)) {
    const uid = ev.source?.userId;
    if (!uid) continue;
    try {
      if (ev.type === 'unfollow') {
        await store.markStopped(uid, 'unfollowed');
        continue;
      }
      if (ev.type !== 'message' || ev.message?.type !== 'text' || !ev.replyToken) continue;
      if (!allow(`line:bind:${uid}`)) continue; // too many tries from this LINE account: stay silent
      const code = parseLinkMessage(ev.message.text ?? '');
      if (!code) {
        await reply(ev.replyToken, helpBothLanguages()).catch(() => {});
        continue;
      }
      const res = await bindLine(store, code, uid, cfg, args.now);
      if (res.ok) {
        const lang = await store.ownerLang(res.ownerId).catch(() => 'en' as Lang);
        await reply(ev.replyToken, LINE_MESSAGES.linked[lang]).catch(() => {}); // the link already worked: a failed reply must not undo it
      } else {
        await reply(
          ev.replyToken,
          `${LINE_MESSAGES.invalidCode.th}\n\n${LINE_MESSAGES.invalidCode.en}`,
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[line] event failed', e instanceof Error ? e.message : 'unknown'); // one bad event never fails the batch
    }
  }
  return { status: 200, body: { ok: true } }; // always 200 for a valid signature, or LINE stops delivering
}

// ── push ────────────────────────────────────────────────────────────────────
export type PushOutcome = 'sent' | 'blocked' | 'auth_failed' | 'rate_limited' | 'retry';

export async function pushLine(
  cfg: Pick<LineConfig, 'channelAccessToken'>,
  to: string,
  message: unknown,
  retryKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  let res: Response;
  try {
    res = await fetchImpl('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.channelAccessToken}`,
        'X-Line-Retry-Key': retryKey,
      },
      body: JSON.stringify({ to, messages: [message] }),
    });
  } catch {
    return 'retry'; // network error
  }
  if (res.status === 200 || res.status === 409) return 'sent'; // 409 = this retry key was already delivered
  if (res.status === 401 || res.status === 403) return 'auth_failed'; // our token is dead: stop everything and tell the admin
  if (res.status === 400) return 'blocked'; // recipient blocked / unreachable: do not retry
  if (res.status === 429) return 'rate_limited';
  return 'retry'; // 5xx
}

/** Send one notice to the user's active LINE, in THEIR language; log the result; stop the channel when LINE says it is dead. */
export async function notifyLine(args: {
  store: LineStore;
  cfg: LineConfig;
  userId: string;
  notice: Notice;
  path?: string;
  kind: string;
  retryKey: string;
  fetchImpl?: typeof fetch;
}): Promise<PushOutcome | 'no_channel'> {
  const { store, cfg, userId, notice, path, kind, retryKey } = args;
  const to = await store.activeAddress(userId);
  if (!to) return 'no_channel';
  const lang = await store.ownerLang(userId).catch(() => 'en' as Lang);
  const message = buildFlexMessage({
    notice,
    openLabel: LINE_MESSAGES.openApp[lang],
    siteUrl: cfg.siteUrl,
    path,
  });
  const outcome = await pushLine(cfg, to, message, retryKey, args.fetchImpl);
  await store
    .log({
      ownerId: userId,
      kind,
      status: outcome === 'sent' ? 'sent' : 'failed',
      ...(outcome === 'sent' ? {} : { error: outcome }),
    })
    .catch(() => {});
  if (outcome === 'blocked') await store.markStopped(to, 'blocked').catch(() => {});
  return outcome;
}

export const testNotice = (lang: Lang): Notice => ({
  title: LINE_MESSAGES.testTitle[lang],
  summary: LINE_MESSAGES.testSummary[lang],
});
