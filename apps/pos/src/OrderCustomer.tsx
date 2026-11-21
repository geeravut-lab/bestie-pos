import { useEffect, useState } from 'react';
import { formatTHB, parsePassScan, parseCustomerCard } from '@bestie/core';
import { CustomerPicker, useRemote } from '@bestie/admin-ui';
import { flush, outboxCounts, pullOrderNow } from '@bestie/offline';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

/** Who this bill belongs to (earns Bestie Points when it is paid). Online only; the till never needs it to sell. */
export function OrderCustomer({
  ctx,
  orderId,
  open,
  online,
}: {
  ctx: PageContext;
  orderId: string;
  open: boolean;
  online: boolean;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const canSee = ctx.isOwner || ctx.permissions.includes('customer.view');
  const [passText, setPassText] = useState('');
  const [passNote, setPassNote] = useState<'attached' | 'unknown' | 'failed' | null>(null);

  const { data, reload } = useRemote(async () => {
    if (!online || !canSee) return null;
    const o = await ctx.client
      .from('orders')
      .select('customer_id, points_used, points_discount')
      .eq('id', orderId)
      .maybeSingle();
    const row = o.data as {
      customer_id?: string | null;
      points_used?: number;
      points_discount?: number;
    } | null;
    const cid = row?.customer_id;
    if (o.error || !cid) return null;
    const [c, bal] = await Promise.all([
      ctx.client
        .from('customers')
        .select('id, name, phone, member_code')
        .eq('id', cid)
        .maybeSingle(),
      ctx.client.rpc('points_balance', { p_customer: cid }),
    ]);
    if (c.error || !c.data) return null;
    const card = parseCustomerCard({ ...(c.data as object), balance: Number(bal.data ?? 0) });
    return card ? { card, used: row?.points_used ?? 0, discount: row?.points_discount ?? 0 } : null;
  }, `${orderId}:${online}:${canSee}`);

  const attach = async (customerId: string | null) => {
    setError(null);
    const { error: err } = await ctx.client.rpc('set_order_customer', {
      p_order: orderId,
      p_customer: customerId,
    });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setPicking(false);
    reload();
  };

  // A Tourist Pass code (BP-…) typed or scanned: the shop's own member record for that guest is found or made, then put on this bill.
  const attachPass = async (raw: string) => {
    setError(null);
    setPassNote(null);
    const code = parsePassScan(raw);
    const store = ctx.storeId ?? ctx.homeStoreId ?? null;
    if (!code || !store) return setPassNote('unknown');
    const r = await ctx.client.rpc('link_pass', { p_store: store, p_code: code });
    if (r.error) return setPassNote('failed');
    const o = (r.data ?? {}) as { ok?: boolean; customer_id?: string };
    if (o.ok !== true || typeof o.customer_id !== 'string') return setPassNote('unknown');
    await attach(o.customer_id);
    setPassText('');
    setPassNote('attached');
  };
  useEffect(() => {
    const onCode = (e: Event) => {
      const code = (e as CustomEvent<string>).detail;
      if (open && online && canSee && typeof code === 'string') void attachPass(code);
    };
    window.addEventListener('bestie:pass-code', onCode);
    return () => window.removeEventListener('bestie:pass-code', onCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, online, canSee, orderId]);

  if (!online || !canSee) return null;

  return (
    <div className="order-customer">
      {data ? (
        <p>
          {fmt(t.custOnBill, { name: data.card.name, points: data.card.points })}{' '}
          {open ? (
            <AsyncButton variant="secondary" onClick={() => attach(null)}>
              {t.custRemove}
            </AsyncButton>
          ) : null}
        </p>
      ) : open && !picking ? (
        <button type="button" className="btn btn-secondary" onClick={() => setPicking(true)}>
          {t.custAttach}
        </button>
      ) : null}
      {data && open ? (
        <PointsControl
          ctx={ctx}
          orderId={orderId}
          available={data.card.points}
          used={data.used}
          discount={data.discount}
          onChanged={reload}
        />
      ) : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {passNote === 'attached' ? <Notice kind="success">{t.nwPassAttached}</Notice> : null}
      {passNote === 'unknown' ? <Notice kind="info">{t.nwPassUnknown}</Notice> : null}
      {passNote === 'failed' ? <Notice kind="error">{t.nwPassLinkFailed}</Notice> : null}
      {picking && open && !data ? (
        <section className="card admin-card">
          <div className="form-row">
            <label className="label" htmlFor="order-pass">
              {t.nwPassScan}
            </label>
            <input
              id="order-pass"
              className="field mono"
              autoComplete="off"
              maxLength={120}
              value={passText}
              onChange={(e) => setPassText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void attachPass(passText);
              }}
            />
            <AsyncButton
              variant="secondary"
              disabled={passText.trim() === ''}
              onClick={() => attachPass(passText)}
            >
              {t.custAttach}
            </AsyncButton>
          </div>
          <CustomerPicker ctx={ctx} idPrefix="order-cust" onPick={(c) => attach(c.id)} />
          <button type="button" className="btn btn-secondary" onClick={() => setPicking(false)}>
            {t.custClose}
          </button>
        </section>
      ) : null}
    </div>
  );
}

/** Use some of the customer's Bestie Points as a discount on this bill (online; the server reserves them and applies the shop's cap). */
function PointsControl({
  ctx,
  orderId,
  available,
  used,
  discount,
  onChanged,
}: {
  ctx: PageContext;
  orderId: string;
  available: number;
  used: number;
  discount: number;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const [wanted, setWanted] = useState('');
  const [note, setNote] = useState<'bad' | 'locked' | 'off' | 'capped' | null>(null);
  const [capNo, setCapNo] = useState(0);
  const [error, setError] = useState<ErrorKey | null>(null);

  const apply = async (n: number) => {
    setError(null);
    setNote(null);
    // the server must see the bill exactly as the tablet does
    await flush(ctx.client as never);
    if ((await outboxCounts()).pending > 0) return setError('err_pay_sync');
    const { data, error: err } = await ctx.client.rpc('set_order_points', {
      p_order: orderId,
      p_wanted: n,
    });
    if (err) {
      if (err.code === '55006') return setNote('locked');
      if (err.code === '0A000') return setNote('off');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    const r = (data ?? {}) as { points_used?: number; cap_points?: number };
    if (n > 0 && (r.points_used ?? 0) < n && typeof r.cap_points === 'number' && r.cap_points < n) {
      setCapNo(r.cap_points);
      setNote('capped');
    }
    setWanted('');
    await pullOrderNow(ctx.client as never, orderId);
    onChanged();
  };

  const count = /^\d{1,7}$/.test(wanted.trim()) ? Number(wanted) : null;
  return (
    <section className="card admin-card" aria-label={t.ptsUseTitle}>
      <h3>{t.ptsUseTitle}</h3>
      {used > 0 ? (
        <p>
          <strong>{fmt(t.ptsUsing, { n: used, discount: formatTHB(discount, locale) })}</strong>{' '}
          <AsyncButton variant="secondary" onClick={() => apply(0)}>
            {t.ptsUseRemove}
          </AsyncButton>
        </p>
      ) : null}
      <p className="muted">{fmt(t.ptsUseHint, { n: available + used })}</p>
      <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-row">
          <label className="label" htmlFor={`pts-${orderId}`}>
            {t.ptsUseInput}
          </label>
          <input
            id={`pts-${orderId}`}
            className="field tabular"
            inputMode="numeric"
            value={wanted}
            onChange={(e) => setWanted(e.target.value)}
          />
        </div>
        {note === 'bad' ? <Notice kind="error">{t.ptsBad}</Notice> : null}
        {note === 'locked' ? <Notice kind="error">{t.ptsLocked}</Notice> : null}
        {note === 'off' ? <Notice kind="error">{t.ptsOff}</Notice> : null}
        {note === 'capped' ? <Notice kind="info">{fmt(t.ptsCapped, { n: capNo })}</Notice> : null}
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        <div className="actions">
          <AsyncButton
            onClick={async () => {
              if (count === null) return setNote('bad');
              await apply(count);
            }}
          >
            {t.ptsUseApply}
          </AsyncButton>
          <AsyncButton variant="secondary" onClick={() => apply(available + used)}>
            {t.ptsUseMax}
          </AsyncButton>
        </div>
      </form>
    </section>
  );
}
