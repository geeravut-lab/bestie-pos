/**
 * Second payment provider: Omise (Opn Payments, Thailand) — PromptPay QR only. Written against Omise's public documentation and covered by unit tests
 * with a fake HTTP client; **it has not been run against a real Omise account** (docs/DECISIONS.md). It is only used when the deployment sets
 * `PAYMENT_GATEWAY=omise` AND both secrets are present; otherwise the till says "not configured" and nothing falls back to another provider.
 *
 * The rules are the same as for every provider (functions/src/gateway.ts): only the SIGNED webhook says "paid"; the database re-checks amount, currency
 * and the bill; we send Omise our attempt id and bill id only. Omise has no server-driven card reader, so a card-reader payment is refused with a clear code.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GatewayError } from './gateway-error.js';
import type { GatewayEvent, PaymentGateway, StartedPayment } from './gateway.js';

export type OmiseConfig = { secretKey: string; webhookSecret: string };

/** `OMISE_SECRET_KEY` (skey_…, never a public pkey_) and `OMISE_WEBHOOK_SECRET` (the endpoint secret from Omise's dashboard). */
export function omiseConfig(env: Record<string, string | undefined>): OmiseConfig | null {
  const secretKey = env.OMISE_SECRET_KEY?.trim();
  const webhookSecret = env.OMISE_WEBHOOK_SECRET?.trim();
  if (!secretKey || !/^skey_(test_)?[A-Za-z0-9]+$/.test(secretKey) || !webhookSecret) return null;
  return { secretKey, webhookSecret };
}

export type OmiseClient = {
  post: (
    path: string,
    params: Record<string, string>,
    idempotencyKey?: string,
  ) => Promise<Record<string, unknown>>;
};

export function createOmiseClient(secretKey: string, fetchImpl: typeof fetch = fetch): OmiseClient {
  return {
    async post(path, params, idempotencyKey) {
      const res = await fetchImpl(`https://api.omise.co${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Omise-Version': '2019-05-29',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&'),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        code?: string;
      };
      if (!res.ok)
        throw new GatewayError(res.status, typeof json.code === 'string' ? json.code : 'unknown');
      if (json.object === 'error')
        throw new GatewayError(
          res.status || 400,
          typeof json.code === 'string' ? json.code : 'unknown',
        );
      return json;
    },
  };
}

/**
 * `Omise-Signature` (hex HMAC-SHA256, possibly several separated by commas, for a rotating secret) and `Omise-Signature-Timestamp`; the HMAC is over
 * `<timestamp>.<raw body>` and the key is the endpoint secret decoded from base64. An old timestamp is refused (replay). Constant-time comparison.
 */
export function verifyOmiseSignature(p: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  secret: string;
  nowMs?: number;
  toleranceSec?: number;
}): boolean {
  if (!p.signature || !p.timestamp || !/^\d{1,12}$/.test(p.timestamp)) return false;
  if (Math.abs((p.nowMs ?? Date.now()) / 1000 - Number(p.timestamp)) > (p.toleranceSec ?? 300))
    return false;
  const key = Buffer.from(p.secret, 'base64');
  const expected = createHmac('sha256', key).update(`${p.timestamp}.${p.rawBody}`).digest();
  return p.signature.split(',').some((s) => {
    const hex = s.trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

type OmiseEvent = {
  id?: string;
  key?: string;
  data?: {
    id?: string;
    amount?: number;
    currency?: string;
    status?: string;
    failure_code?: string;
    metadata?: Record<string, string>;
  };
};
const UUID = /^[0-9a-f-]{36}$/i;

export function omiseGateway(client: OmiseClient, cfg: OmiseConfig): PaymentGateway {
  return {
    id: 'omise',
    async startPromptPay(p): Promise<StartedPayment> {
      const charge = await client.post(
        '/charges',
        {
          amount: String(p.amount),
          currency: 'thb',
          'source[type]': 'promptpay',
          description: `Bestie POS ${p.attemptId.slice(0, 8)}`,
          'metadata[attempt_id]': p.attemptId,
          ...(p.orderId
            ? { 'metadata[order_id]': p.orderId }
            : { 'metadata[kind]': 'credit_topup' }),
        },
        `bestie-attempt-${p.attemptId}`,
      );
      const src = charge.source as
        { scannable_code?: { image?: { download_uri?: string } } } | undefined;
      const qr = src?.scannable_code?.image?.download_uri;
      if (typeof charge.id !== 'string' || typeof qr !== 'string')
        throw new GatewayError(502, 'no_qr');
      return { providerRef: charge.id, qrImageUrl: qr, qrData: null };
    },
    async startReader(): Promise<StartedPayment> {
      throw new GatewayError(501, 'reader_not_supported');
    },
    async cancel(): Promise<void> {
      // a PromptPay charge cannot be cancelled; it simply expires. A payment that arrives anyway still closes the bill through the webhook.
    },
    readWebhook({ rawBody, headers }): GatewayEvent | null {
      if (
        !verifyOmiseSignature({
          rawBody,
          signature: headers.get('omise-signature'),
          timestamp: headers.get('omise-signature-timestamp'),
          secret: cfg.webhookSecret,
        })
      )
        return null;
      let event: OmiseEvent;
      try {
        event = JSON.parse(rawBody) as OmiseEvent;
      } catch {
        return null;
      }
      const eventId = typeof event.id === 'string' ? event.id : null;
      const key = event.key ?? '';
      const d = event.data;
      const attemptId = d?.metadata?.attempt_id;
      if (
        key !== 'charge.complete' ||
        typeof attemptId !== 'string' ||
        !UUID.test(attemptId) ||
        typeof d?.id !== 'string'
      )
        return { kind: 'ignored', eventId, type: key };
      if (d.status === 'successful')
        return {
          kind: 'succeeded',
          eventId,
          type: key,
          attemptId,
          providerRef: d.id,
          amount: d.amount ?? 0,
          currency: (d.currency ?? '').toLowerCase(),
        };
      if (d.status === 'expired' || d.status === 'reversed')
        return { kind: 'canceled', eventId, type: key, attemptId, error: d.status };
      if (d.status === 'failed')
        return { kind: 'failed', eventId, type: key, attemptId, error: d.failure_code ?? 'failed' };
      return { kind: 'ignored', eventId, type: key };
    },
  };
}
