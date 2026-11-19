import type { SupabaseClient } from '@supabase/supabase-js';
import type { ErrorKey } from '@bestie/i18n';

export type TopupTender = 'promptpay' | 'gateway';
export type TopupStatus =
  'created' | 'pending' | 'succeeded' | 'failed' | 'canceled' | 'needs_review';
export type TopupCharge = {
  attemptId: string;
  tender: TopupTender;
  amount: number;
  qrImageUrl: string | null;
};

const errorFor = (status: number, code: string | undefined): ErrorKey =>
  status === 503
    ? 'err_pay_not_configured'
    : status === 403
      ? 'err_forbidden'
      : status === 409
        ? 'err_topup_pending'
        : status === 422
          ? 'err_topup_invalid'
          : status === 429
            ? 'err_rate_limited'
            : code === 'provider_error' || status === 502
              ? 'err_pay_provider'
              : 'err_pay_failed';

/**
 * Ask the server for a PromptPay QR / card-reader payment that, once Stripe's signed webhook confirms it, becomes Bestie
 * Credit of this customer. Nothing is credited here; the screen only waits and reads the attempt.
 */
export async function startTopup(p: {
  client: SupabaseClient;
  customerId: string;
  storeId: string;
  deviceId: string;
  tender: TopupTender;
  amount: number;
  fetchImpl?: typeof fetch;
}): Promise<{ charge: TopupCharge } | { error: ErrorKey }> {
  if (globalThis.navigator?.onLine === false) return { error: 'err_pay_offline' };
  const token = (await p.client.auth.getSession()).data.session?.access_token;
  if (!token) return { error: 'err_forbidden' };
  try {
    const res = await (p.fetchImpl ?? fetch)('/api/stripe/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        topup: {
          customer_id: p.customerId,
          store_id: p.storeId,
          device_id: p.deviceId,
          tender: p.tender,
          amount: p.amount,
        },
      }),
    });
    const b = (await res.json().catch(() => ({}))) as {
      attempt_id?: string;
      amount?: number;
      qr_image_url?: string | null;
      error?: string;
    };
    if (!res.ok || !b.attempt_id) return { error: errorFor(res.status, b.error) };
    return {
      charge: {
        attemptId: b.attempt_id,
        tender: p.tender,
        amount: b.amount ?? p.amount,
        qrImageUrl: b.qr_image_url ?? null,
      },
    };
  } catch {
    return { error: 'err_pay_offline' };
  }
}

export async function cancelTopup(
  client: SupabaseClient,
  attemptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = (await client.auth.getSession()).data.session?.access_token;
  if (!token) return;
  try {
    await fetchImpl('/api/stripe/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ attempt_id: attemptId }),
    });
  } catch {
    /* offline: the attempt stays waiting and can be cancelled later */
  }
}

export async function readTopup(
  client: SupabaseClient,
  attemptId: string,
): Promise<{ status: TopupStatus; error: string | null } | null> {
  const r = await client
    .from('payment_attempts')
    .select('status, error')
    .eq('id', attemptId)
    .maybeSingle();
  const row = r.data as { status?: TopupStatus; error?: string | null } | null;
  return !r.error && row?.status ? { status: row.status, error: row.error ?? null } : null;
}

/** A top-up of this customer that is still waiting (a refresh or a second tablet must not strand it). */
export async function findLiveTopup(
  client: SupabaseClient,
  customerId: string,
): Promise<TopupCharge | null> {
  const r = await client
    .from('payment_attempts')
    .select('id, tender, amount, qr_url')
    .eq('customer_id', customerId)
    .eq('kind', 'credit_topup')
    .in('status', ['created', 'pending'])
    .limit(1);
  const row = (
    r.data as { id: string; tender: TopupTender; amount: number; qr_url: string | null }[] | null
  )?.[0];
  return !r.error && row
    ? { attemptId: row.id, tender: row.tender, amount: row.amount, qrImageUrl: row.qr_url }
    : null;
}
