import {
  hasUnsent,
  onlineSnapshot,
  orderBill,
  payBlockers,
  planSplit,
  sendNew,
} from '@bestie/core';
import type { BillConfig, Lang, OnlineTender, RoundingRule, Satang, SplitLeg } from '@bestie/core';
import type { ErrorKey } from '@bestie/i18n';
import { flush, getOrder, outboxCounts, pullOrderNow } from '@bestie/offline';
import type { PageContext } from '@bestie/auth';
import { changeOrder } from './orderActions';
import type { DeviceBinding } from '@bestie/offline';

type Client = PageContext['client'];

export type AttemptStatus =
  'created' | 'pending' | 'succeeded' | 'failed' | 'canceled' | 'needs_review';
export type Charge = {
  attemptId: string;
  tender: OnlineTender;
  amount: number;
  qrImageUrl: string | null;
};

/** What the screen needs to run an online payment (built in OrderPage; faked in tests). */
export type OnlinePay = {
  /** Network up. */
  available: boolean;
  /** The device has a card reader registered. */
  hasReader: boolean;
  start: (tender: OnlineTender) => Promise<{ charge: Charge } | { error: ErrorKey }>;
  cancel: (attemptId: string) => Promise<void>;
  status: (attemptId: string) => Promise<{ status: AttemptStatus; error: string | null } | null>;
  /** A payment for this bill that is still waiting (a refresh or a second tablet must not strand it). */
  findLive: () => Promise<Charge | null>;
  /** The server closed the bill: bring it (with its receipt) to this tablet. */
  finish: () => Promise<void>;
};

const errorFor = (status: number, code: string | undefined): ErrorKey =>
  status === 503
    ? 'err_pay_not_configured'
    : status === 403
      ? 'err_forbidden'
      : status === 409
        ? 'err_pay_pending'
        : status === 429
          ? 'err_rate_limited'
          : code === 'provider_error' || status === 502
            ? 'err_pay_provider'
            : 'err_pay_failed';

/**
 * Start a PromptPay / card payment. First everything unsent goes to the kitchen and the queue is flushed (the server must
 * know the bill exactly as it is on screen), then the server is asked. The till never marks the bill paid by itself.
 */
export async function startOnlinePayment(p: {
  client: Client;
  orderId: string;
  tender: OnlineTender;
  binding: DeviceBinding;
  billConfig: BillConfig;
  staffId?: string;
  lang: Lang;
}): Promise<{ charge: Charge } | { error: ErrorKey }> {
  if (globalThis.navigator?.onLine === false) return { error: 'err_pay_offline' };
  const first = await getOrder(p.orderId);
  if (!first) return { error: 'err_order_failed' };
  if (payBlockers(first).some((b) => b !== 'unsent'))
    return { error: first.status === 'paid' ? 'err_order_closed' : 'err_pay_failed' };
  if (hasUnsent(first)) {
    const err = await changeOrder(p.orderId, (o) => sendNew(o, Date.now()).order);
    if (err) return { error: err };
  }
  await flush(p.client as never);
  if ((await outboxCounts()).pending > 0) return { error: 'err_pay_sync' };

  const order = await getOrder(p.orderId);
  if (!order) return { error: 'err_order_failed' };
  const snapshot = onlineSnapshot({
    order,
    bill: orderBill(order, p.billConfig),
    billConfig: p.billConfig,
    tender: p.tender,
    deviceId: p.binding.deviceId,
    staffId: p.staffId ?? null,
    lang: p.lang,
  });
  const token = (await p.client.auth.getSession()).data.session?.access_token;
  if (!token) return { error: 'err_forbidden' };
  try {
    const res = await fetch('/api/stripe/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ snapshot }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      attempt_id?: string;
      amount?: number;
      qr_image_url?: string | null;
      error?: string;
    };
    if (!res.ok || !body.attempt_id) return { error: errorFor(res.status, body.error) };
    return {
      charge: {
        attemptId: body.attempt_id,
        tender: p.tender,
        amount: body.amount ?? (snapshot.payable as number),
        qrImageUrl: body.qr_image_url ?? null,
      },
    };
  } catch {
    return { error: 'err_pay_offline' };
  }
}

export async function cancelOnlinePayment(client: Client, attemptId: string): Promise<void> {
  const token = (await client.auth.getSession()).data.session?.access_token;
  if (!token) return;
  try {
    await fetch('/api/stripe/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ attempt_id: attemptId }),
    });
  } catch {
    /* offline: the attempt stays pending and can be cancelled later */
  }
}

export async function readAttempt(
  client: Client,
  attemptId: string,
): Promise<{ status: AttemptStatus; error: string | null } | null> {
  const r = await client
    .from('payment_attempts')
    .select('status, error')
    .eq('id', attemptId)
    .maybeSingle();
  const row = r.data as { status?: AttemptStatus; error?: string | null } | null;
  return !r.error && row?.status ? { status: row.status, error: row.error ?? null } : null;
}

export async function findLiveAttempt(client: Client, orderId: string): Promise<Charge | null> {
  const r = await client
    .from('payment_attempts')
    .select('id, tender, amount, qr_url')
    .eq('order_id', orderId)
    .in('status', ['created', 'pending'])
    .limit(1);
  const row = (
    r.data as { id: string; tender: OnlineTender; amount: number; qr_url: string | null }[] | null
  )?.[0];
  return !r.error && row
    ? { attemptId: row.id, tender: row.tender, amount: row.amount, qrImageUrl: row.qr_url }
    : null;
}

export const finishOnlinePayment = (client: Client, orderId: string): Promise<boolean> =>
  pullOrderNow(client as never, orderId);

/**
 * Several payers, cash and / or Bestie Credit, one receipt: the server closes the bill in one transaction
 * (`close_order_tenders`) and numbers the receipt. Online only. Like a PromptPay start, everything unsent goes to the
 * kitchen first and the queue is flushed, so the server sees the bill exactly as it is on screen.
 */
export async function closeSplitPayment(p: {
  client: Client;
  orderId: string;
  binding: DeviceBinding;
  billConfig: BillConfig;
  rule: RoundingRule;
  legs: SplitLeg[];
  creditBalance: Satang | null;
  staffId?: string;
  lang: Lang;
}): Promise<ErrorKey | null> {
  if (globalThis.navigator?.onLine === false) return 'err_pay_offline';
  const first = await getOrder(p.orderId);
  if (!first) return 'err_order_failed';
  if (payBlockers(first).some((b) => b !== 'unsent'))
    return first.status === 'paid' ? 'err_order_closed' : 'err_pay_failed';
  if (hasUnsent(first)) {
    const err = await changeOrder(p.orderId, (o) => sendNew(o, Date.now()).order);
    if (err) return err;
  }
  await flush(p.client as never);
  if ((await outboxCounts()).pending > 0) return 'err_pay_sync';
  const order = await getOrder(p.orderId);
  if (!order) return 'err_order_failed';

  const bill = orderBill(order, p.billConfig);
  const plan = planSplit({
    total: bill.total,
    rule: p.rule,
    legs: p.legs,
    creditBalance: p.creditBalance,
  });
  if (plan.problems.length > 0) return 'err_pay_failed';
  const { error } = await p.client.rpc('close_order_tenders', {
    p: {
      order_id: order.id,
      device_id: p.binding.deviceId,
      staff_id: p.staffId ?? null,
      issued_at: new Date().toISOString(),
      lang: p.lang,
      subtotal: bill.subtotal,
      points_discount: bill.pointsDiscount,
      service_charge: bill.serviceCharge,
      vat: bill.vat,
      net_before_vat: bill.netBeforeVat,
      total: bill.total,
      rounding: plan.rounding,
      payable: plan.payable,
      vat_bps: p.billConfig.vatBps,
      service_bps: p.billConfig.serviceChargeBps,
      price_mode: p.billConfig.priceMode,
      payments: plan.payments.map((x) => ({ id: crypto.randomUUID(), ...x })),
    },
  });
  if (error) {
    if (error.code === '42501') return 'err_forbidden';
    if (error.code === '55000') return 'err_pay_sync';
    return 'err_pay_failed';
  }
  await pullOrderNow(p.client as never, p.orderId);
  return null;
}
