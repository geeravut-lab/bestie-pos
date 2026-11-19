/**
 * "Why does LINE not answer?" — the platform admin's connection check. It asks LINE itself about the bot (is the token accepted, which
 * webhook address is set, is "use webhook" on, does a test call succeed) and sets that next to what this server has actually received in
 * the last 24 hours (`line_webhook_log`: outcomes only, never message text). Pure evaluation on top, so it is tested without a network.
 * The screen turns each check id + level into a plain Thai / English sentence; nothing here contains provider text.
 */
export type Level = 'ok' | 'fail' | 'warn' | 'info';
export type Check = { id: string; level: Level; data?: Record<string, string | number | boolean> };

export type DiagnosisInput = {
  /** names of the LINE variables that are NOT set on the server */
  missingEnv: string[];
  expectedWebhook: string;
  configuredBasicId: string;
  /** LINE's answers; `null` = the call itself failed (network) */
  info: { status: number; basicId?: string; displayName?: string } | null;
  endpoint: { status: number; endpoint?: string; active?: boolean } | null;
  test: { status: number; success?: boolean; statusCode?: number; reason?: string } | null;
  /** outcome → count, last 24 h */
  recent: Record<string, number>;
  pendingLinks: number;
};

const norm = (id: string): string => id.trim().replace(/^@/, '').toLowerCase();
const num = (r: Record<string, number>, prefix: string): number =>
  Object.entries(r).reduce(
    (a, [k, v]) => (k === prefix || k.startsWith(`${prefix}_`) ? a + v : a),
    0,
  );

export function evaluateDiagnosis(i: DiagnosisInput): Check[] {
  const out: Check[] = [];
  if (i.missingEnv.length > 0) {
    out.push({ id: 'env', level: 'fail', data: { names: i.missingEnv.join(', ') } });
    return out; // nothing else can be asked without the secrets
  }
  out.push({ id: 'env', level: 'ok' });

  // 1. the access token
  if (!i.info) out.push({ id: 'token', level: 'warn', data: { reason: 'network' } });
  else if (i.info.status === 401 || i.info.status === 403)
    out.push({ id: 'token', level: 'fail', data: { status: i.info.status } });
  else if (i.info.status !== 200)
    out.push({ id: 'token', level: 'warn', data: { status: i.info.status } });
  else {
    out.push({ id: 'token', level: 'ok', data: { name: i.info.displayName ?? '' } });
    if (i.info.basicId && norm(i.info.basicId) !== norm(i.configuredBasicId))
      out.push({
        id: 'basic_id',
        level: 'warn',
        data: { set: i.configuredBasicId, real: i.info.basicId },
      });
    else out.push({ id: 'basic_id', level: 'ok', data: { id: i.configuredBasicId } });
  }

  // 2. the webhook address set in LINE Developers
  if (!i.endpoint) out.push({ id: 'webhook_url', level: 'warn', data: { reason: 'network' } });
  else if (i.endpoint.status === 401 || i.endpoint.status === 403)
    out.push({ id: 'webhook_url', level: 'fail', data: { reason: 'token' } });
  else if (i.endpoint.status !== 200)
    out.push({ id: 'webhook_url', level: 'warn', data: { status: i.endpoint.status } });
  else if (!i.endpoint.endpoint)
    out.push({
      id: 'webhook_url',
      level: 'fail',
      data: { reason: 'none', expected: i.expectedWebhook },
    });
  else if (i.endpoint.endpoint.replace(/\/$/, '') !== i.expectedWebhook)
    out.push({
      id: 'webhook_url',
      level: 'fail',
      data: { reason: 'different', url: i.endpoint.endpoint, expected: i.expectedWebhook },
    });
  else if (i.endpoint.active === false)
    out.push({
      id: 'webhook_url',
      level: 'fail',
      data: { reason: 'inactive', url: i.endpoint.endpoint },
    });
  else out.push({ id: 'webhook_url', level: 'ok', data: { url: i.endpoint.endpoint } });

  // 3. LINE's own test call to that address (a signed, empty batch of events)
  if (!i.test) out.push({ id: 'webhook_test', level: 'warn', data: { reason: 'network' } });
  else if (i.test.status !== 200)
    out.push({ id: 'webhook_test', level: 'warn', data: { status: i.test.status } });
  else if (i.test.success)
    out.push({ id: 'webhook_test', level: 'ok', data: { status: i.test.statusCode ?? 200 } });
  else
    out.push({
      id: 'webhook_test',
      level: 'fail',
      data: { status: i.test.statusCode ?? 0, reason: (i.test.reason ?? '').slice(0, 80) },
    });

  // 4. what actually reached us
  // LINE's own verify / test calls carry no events (`ok_empty`): they prove nothing about real chat messages
  const total = Object.entries(i.recent).reduce(
    (a, [k, v]) => (k === 'ok_empty' || k === 'not_configured' ? a : a + v),
    0,
  );
  const badSig = num(i.recent, 'bad_signature');
  const replyFail = num(i.recent, 'reply_failed');
  if (badSig > 0)
    out.push({ id: 'recent', level: 'fail', data: { reason: 'signature', n: badSig } });
  else if (replyFail > 0) {
    const key = Object.keys(i.recent).find((k) => k.startsWith('reply_failed_')) ?? '';
    out.push({
      id: 'recent',
      level: 'fail',
      data: { reason: 'reply', n: replyFail, status: key.replace('reply_failed_', '') },
    });
  } else if (total === 0) out.push({ id: 'recent', level: 'warn', data: { reason: 'none' } });
  else out.push({ id: 'recent', level: 'ok', data: { n: total } });

  out.push({ id: 'pending', level: 'info', data: { n: i.pendingLinks } });
  return out;
}
