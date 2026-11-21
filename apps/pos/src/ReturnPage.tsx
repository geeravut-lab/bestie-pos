import { useMemo, useState } from 'react';
import {
  formatTHB,
  RETURN_REASONS,
  returnAmount,
  returnableQty,
  usableRoutes,
  routeAvailable,
} from '@bestie/core';
import type { PaidByTender, ReturnMethod, ReturnReason } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { useOnline } from '@bestie/offline';
import { useRemote } from '@bestie/admin-ui';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { LoadFailed, Loading, Page } from './PosBits';
import { ReturnSlipButton } from './ReturnSlip';
import { usePosStore } from './posData';

type SoldLine = {
  id: string;
  name: { th: string; en?: string };
  unitPrice: number;
  quantity: number;
  returned: number;
};
type Loaded = {
  number: string;
  receiptNumber: string;
  payable: number;
  customerId: string | null;
  lines: SoldLine[];
  payments: PaidByTender[];
  returns: { method: ReturnMethod; amount: number }[];
  /** A bill charged to a room: is the guest's stay still open? */
  roomStay: 'open' | 'closed' | null;
  earlier: { id: string; number: string; amount: number }[];
};

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

async function loadBill(ctx: PageContext, orderId: string): Promise<Loaded | null> {
  const c = ctx.client;
  const [ord, rec, lines, pays, rlines, rets] = await Promise.all([
    c.from('orders').select('number, status, customer_id').eq('id', orderId).maybeSingle(),
    c.from('receipts').select('number, payable').eq('order_id', orderId).maybeSingle(),
    c.from('order_lines').select('id, name, unit_price, quantity, status').eq('order_id', orderId),
    c.from('payments').select('tender, amount').eq('order_id', orderId).eq('status', 'confirmed'),
    c.from('order_return_lines').select('order_line_id, quantity').eq('order_id', orderId),
    c.from('order_returns').select('id, number, refund_method, amount').eq('order_id', orderId),
  ]);
  for (const r of [ord, rec, lines, pays, rlines, rets])
    if (r.error) throw new Error(r.error.message);
  // a bill charged to a room: is the stay still open? (a failed lookup just means the room route is not offered)
  let roomStay: 'open' | 'closed' | null = null;
  if (((pays.data ?? []) as { tender: string }[]).some((p) => p.tender === 'room')) {
    const ch = await c
      .from('folio_charges')
      .select('folio_id, voided_at')
      .eq('order_id', orderId)
      .maybeSingle();
    const row = ch.data as { folio_id?: string; voided_at?: string | null } | null;
    if (!ch.error && row?.folio_id) {
      const st = await c.from('folios').select('status').eq('id', row.folio_id).maybeSingle();
      const status = (st.data as { status?: string } | null)?.status;
      roomStay = row.voided_at ? 'closed' : status === 'open' ? 'open' : 'closed';
    }
  }
  if (!ord.data || !rec.data || ord.data.status !== 'paid') return null;
  const back = new Map<string, number>();
  for (const r of (rlines.data ?? []) as { order_line_id: string; quantity: number }[])
    back.set(r.order_line_id, (back.get(r.order_line_id) ?? 0) + num(r.quantity));
  return {
    number: String(ord.data.number),
    receiptNumber: String(rec.data.number),
    payable: num(rec.data.payable),
    customerId: (ord.data.customer_id as string | null) ?? null,
    lines: ((lines.data ?? []) as Record<string, unknown>[])
      .filter((l) => l.status !== 'void')
      .map((l) => ({
        id: String(l.id),
        name: l.name as SoldLine['name'],
        unitPrice: num(l.unit_price),
        quantity: num(l.quantity),
        returned: back.get(String(l.id)) ?? 0,
      })),
    payments: ((pays.data ?? []) as { tender: string; amount: number }[]).map((p) => ({
      tender: p.tender,
      amount: num(p.amount),
    })),
    returns: ((rets.data ?? []) as { refund_method: ReturnMethod; amount: number }[]).map((r) => ({
      method: r.refund_method,
      amount: num(r.amount),
    })),
    roomStay,
    earlier: ((rets.data ?? []) as { id: string; number: string; amount: number }[]).map((r) => ({
      id: String(r.id),
      number: String(r.number),
      amount: num(r.amount),
    })),
  };
}

const reasonText = (t: ReturnType<typeof useI18n>['t'], r: ReturnReason): string =>
  ({
    wrong_item: t.returnReasonWrong,
    defective: t.returnReasonDefective,
    changed_mind: t.returnReasonChanged,
    other: t.returnReasonOther,
  })[r];

/**
 * Take a product return against a paid bill (manager / owner, online). The amount is shown from the same rule the database uses;
 * the database computes it again and refuses anything a route did not take.
 */
export function ReturnPage({ ctx, orderId }: { ctx: PageContext; orderId: string }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const online = useOnline();
  const { binding } = usePosStore(ctx);
  const bill = useRemote(() => loadBill(ctx, orderId), `${orderId}:${ctx.orgId}`);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<ReturnReason>('changed_mind');
  const [method, setMethod] = useState<ReturnMethod | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  // one id per attempt: pressing the button twice, or a retry after a lost answer, can never return twice
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());

  const allowed = ctx.isOwner || ctx.permissions.includes('refund.create');
  const data = bill.data;
  const creditAllowed = (ctx.isModuleOn?.('tender.credit') ?? false) && data?.customerId != null;

  const amount = useMemo(
    () =>
      data
        ? returnAmount({
            payable: data.payable,
            refundedBefore: data.returns.reduce((n, r) => n + r.amount, 0),
            lines: data.lines.map((l) => ({
              unitPrice: l.unitPrice,
              quantity: l.quantity,
              returned: l.returned,
              now: qty[l.id] ?? 0,
            })),
          })
        : 0,
    [data, qty],
  );
  const picked = Object.values(qty).reduce((n, q) => n + q, 0);
  const routes = data
    ? usableRoutes(amount, data.payments, data.returns, creditAllowed, data.roomStay)
    : [];
  const chosen: ReturnMethod | '' = method && routes.includes(method) ? method : (routes[0] ?? '');

  if (!allowed)
    return (
      <Page title={t.returnTitle}>
        <Notice kind="error">{t.returnNeedPermission}</Notice>
      </Page>
    );
  if (bill.status === 'loading') return <Loading />;
  if (bill.status === 'error') return <LoadFailed onRetry={bill.reload} />;
  if (!data)
    return (
      <Page title={t.returnTitle}>
        <Notice kind="info">{t.receiptNotPaid}</Notice>
      </Page>
    );

  const left = data.lines.reduce((n, l) => n + returnableQty(l.quantity, l.returned), 0);

  const submit = async () => {
    setError(null);
    if (!chosen || picked === 0) return;
    const { data: res, error: err } = await ctx.client.rpc('create_return', {
      p: {
        id: attemptId,
        order_id: orderId,
        device_id: binding?.deviceId ?? null,
        staff_id: ctx.staffId ?? null,
        reason,
        note: note.trim() || null,
        refund_method: chosen,
        lines: data.lines
          .filter((l) => (qty[l.id] ?? 0) > 0)
          .map((l) => ({
            order_line_id: l.id,
            quantity: qty[l.id],
            restock: restock[l.id] ?? true,
          })),
      },
    });
    if (err) {
      setError(
        err.code === '42501'
          ? 'err_forbidden'
          : err.code === '23514'
            ? 'err_return_limit'
            : err.code === '0A000'
              ? 'err_return_credit_off'
              : 'err_save_failed',
      );
      return;
    }
    const r = res as { number?: string; amount?: number; points_reversed?: number } | null;
    setDone(
      fmt(t.returnDone, {
        number: r?.number ?? '',
        amount: formatTHB(num(r?.amount), locale),
      }) + (r?.points_reversed ? ` · ${fmt(t.returnPointsBack, { n: r.points_reversed })}` : ''),
    );
    setDoneId(attemptId);
    setQty({});
    setAttemptId(crypto.randomUUID());
    bill.reload();
  };

  return (
    <Page title={t.returnTitle}>
      <p className="muted">
        {fmt(t.returnBill, { number: data.receiptNumber })} · {formatTHB(data.payable, locale)}
      </p>
      {!online ? <Notice kind="info">{t.returnOnline}</Notice> : null}
      {done ? <Notice kind="success">{done}</Notice> : null}
      {doneId ? <ReturnSlipButton ctx={ctx} returnId={doneId} /> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {left === 0 ? <Notice kind="info">{t.returnNothingLeft}</Notice> : null}

      {left > 0 ? (
        <>
          <h2>{t.returnPick}</h2>
          <ul className="member-list">
            {data.lines.map((l) => {
              const max = returnableQty(l.quantity, l.returned);
              const name = lang === 'en' && l.name.en ? l.name.en : l.name.th;
              return (
                <li key={l.id} className="member-row">
                  <div>
                    <strong>{name}</strong>
                    <div className="muted">
                      {formatTHB(l.unitPrice, locale)} · {fmt(t.returnSold, { n: l.quantity })}
                      {l.returned > 0 ? ` · ${fmt(t.returnAlready, { n: l.returned })}` : ''}
                    </div>
                  </div>
                  {max > 0 ? (
                    <div className="actions">
                      <label className="label" htmlFor={`rq-${l.id}`}>
                        {t.returnQtyLabel}
                      </label>
                      <input
                        id={`rq-${l.id}`}
                        className="field tabular"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={max}
                        value={qty[l.id] ?? 0}
                        onChange={(e) =>
                          setQty({
                            ...qty,
                            [l.id]: Math.min(
                              max,
                              Math.max(0, Math.trunc(Number(e.target.value)) || 0),
                            ),
                          })
                        }
                      />
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={restock[l.id] ?? true}
                          onChange={(e) => setRestock({ ...restock, [l.id]: e.target.checked })}
                        />{' '}
                        {t.returnRestock}
                      </label>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className="form-row">
            <label className="label" htmlFor="ret-reason">
              {t.returnReasonLabel}
            </label>
            <select
              id="ret-reason"
              className="field"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReturnReason)}
            >
              {RETURN_REASONS.map((r) => (
                <option key={r} value={r}>
                  {reasonText(t, r)}
                </option>
              ))}
            </select>
          </div>

          <p>
            <strong>{t.returnAmountLabel}:</strong>{' '}
            <span className="tabular">{formatTHB(amount, locale)}</span>
          </p>

          {picked > 0 && routes.length === 0 ? (
            <Notice kind="error">{t.returnNoRoute}</Notice>
          ) : null}
          {routes.length > 0 ? (
            <fieldset className="form-row">
              <legend className="label">{t.returnMethodLabel}</legend>
              {routes.map((m) => (
                <label key={m} className="check">
                  <input
                    type="radio"
                    name="ret-method"
                    checked={chosen === m}
                    onChange={() => setMethod(m)}
                  />{' '}
                  {m === 'cash'
                    ? t.returnMethodCash
                    : m === 'credit'
                      ? t.returnMethodCredit
                      : m === 'room'
                        ? t.returnMethodRoom
                        : t.returnMethodManual}{' '}
                  <span className="muted tabular">
                    (
                    {formatTHB(
                      routeAvailable(m, data.payments, data.returns, data.roomStay),
                      locale,
                    )}
                    )
                  </span>
                </label>
              ))}
              {chosen === 'manual' ? <p className="muted">{t.returnMethodManualHint}</p> : null}
              {chosen === 'room' ? <p className="muted">{t.returnMethodRoomHint}</p> : null}
            </fieldset>
          ) : null}

          <div className="form-row">
            <label className="label" htmlFor="ret-note">
              {t.returnNoteLabel}
            </label>
            <input
              id="ret-note"
              className="field"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="actions">
            <AsyncButton onClick={submit} disabled={!online || picked === 0 || chosen === ''}>
              {t.returnSubmit}
            </AsyncButton>
          </div>
        </>
      ) : null}
      {data.earlier.length > 0 ? (
        <>
          <h2>{t.returnEarlier}</h2>
          <ul className="member-list">
            {data.earlier.map((e) => (
              <li key={e.id} className="member-row">
                <strong className="tabular">{e.number}</strong>
                <span className="tabular">{formatTHB(e.amount, locale)}</span>
                <ReturnSlipButton ctx={ctx} returnId={e.id} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Page>
  );
}
