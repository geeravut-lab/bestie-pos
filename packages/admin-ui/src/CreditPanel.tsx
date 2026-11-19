import { useState } from 'react';
import { formatTHB, parsePriceInput } from '@bestie/core';
import type { CustomerCard } from '@bestie/core';
import { errorText, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { getDeviceBinding } from '@bestie/offline';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { CreditOnlineTopup } from './CreditOnlineTopup';
import { useRemote } from './useRemote';

type Row = { id: string; kind: string; amount: number; reason: string | null; created_at: string };

/**
 * Bestie Credit of one member in THIS shop's legal entity: balance, history, cash top-up, manager correction.
 * Shown only where the shop has switched the `tender.credit` module on (it is off by default).
 */
export function CreditPanel({ ctx, card }: { ctx: PageContext; card: CustomerCard }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const storeId = getDeviceBinding()?.storeId ?? ctx.homeStoreId ?? ctx.storeId;
  const canTopup = ctx.isOwner || ctx.permissions.includes('payment.take');
  const canAdjust = ctx.isOwner || ctx.permissions.includes('credit.adjust');
  const [amount, setAmount] = useState('');
  const [adj, setAdj] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<
    'topupBad' | 'tooMuch' | 'adjBad' | 'topped' | 'adjusted' | null
  >(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const { status, data, reload } = useRemote(
    async () => {
      if (!storeId) return null;
      const s = await ctx.client
        .from('stores')
        .select('id, legal_entity_id, module_overrides')
        .eq('id', storeId)
        .maybeSingle();
      const row = s.data as {
        id: string;
        legal_entity_id: string;
        module_overrides: Record<string, unknown>;
      } | null;
      if (s.error) throw new Error('load');
      // registry: tender.credit is off for every profile; only the owner's explicit switch turns it on
      if (!row || row.module_overrides?.['tender.credit'] !== true) return null;
      const [bal, hist] = await Promise.all([
        ctx.client.rpc('credit_balance', { p_customer: card.id, p_entity: row.legal_entity_id }),
        ctx.client
          .from('credit_ledger')
          .select('id, kind, amount, reason, created_at')
          .eq('customer_id', card.id)
          .eq('legal_entity_id', row.legal_entity_id)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);
      if (bal.error || hist.error) throw new Error('load');
      const bound = getDeviceBinding()?.deviceId;
      const dev = bound
        ? await ctx.client.from('devices').select('stripe_reader_id').eq('id', bound).maybeSingle()
        : null;
      return {
        storeId: row.id,
        hasReader:
          typeof (dev?.data as { stripe_reader_id?: unknown } | null)?.stripe_reader_id ===
          'string',
        balance: Number(bal.data ?? 0),
        history: (hist.data ?? []) as Row[],
      };
    },
    `${card.id}:${storeId ?? ''}`,
  );

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error') return <Notice kind="error">{t.err_load_failed}</Notice>;
  if (!data) return null;

  const topup = async () => {
    setError(null);
    setNote(null);
    const v = parsePriceInput(amount);
    if (v === null || v < 10000 || v > 5000000) return setNote('topupBad');
    const { error: err } = await ctx.client.rpc('topup_credit', {
      p: {
        id: crypto.randomUUID(),
        customer_id: card.id,
        store_id: data.storeId,
        device_id: getDeviceBinding()?.deviceId ?? null,
        amount: v,
        funding: 'cash',
      },
    });
    if (err) {
      if (err.code === '22023')
        return setNote(v + data.balance > 20000000 ? 'tooMuch' : 'topupBad');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setAmount('');
    setNote('topped');
    reload();
  };

  const adjust = async () => {
    setError(null);
    setNote(null);
    const neg = adj.trim().startsWith('-');
    const v = parsePriceInput(adj.trim().replace(/^-/, ''));
    if (v === null || v === 0 || reason.trim().length === 0) return setNote('adjBad');
    const { error: err } = await ctx.client.rpc('adjust_credit', {
      p_customer: card.id,
      p_store: data.storeId,
      p_amount: neg ? -v : v,
      p_reason: reason.trim(),
    });
    if (err) {
      if (err.code === '22023' || err.code === '23514') return setNote('adjBad');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setAdj('');
    setReason('');
    setNote('adjusted');
    reload();
  };

  const kind = (k: string) => (t as Record<string, string>)[`creditKind_${k}`] ?? k;

  return (
    <section className="card admin-card" aria-label={t.creditTitle}>
      <h3>{t.creditTitle}</h3>
      <p className="muted">{t.creditRule}</p>
      <p className="guest-total">
        <span>{t.creditBalance}</span>
        <strong className="tabular">{formatTHB(data.balance, locale)}</strong>
      </p>
      {note === 'topped' ? <Notice kind="success">{t.creditTopupDone}</Notice> : null}
      {note === 'adjusted' ? <Notice kind="success">{t.custAdjusted}</Notice> : null}
      {note === 'topupBad' ? <Notice kind="error">{t.creditTopupBad}</Notice> : null}
      {note === 'tooMuch' ? <Notice kind="error">{t.creditTooMuch}</Notice> : null}
      {note === 'adjBad' ? <Notice kind="error">{t.creditAdjustBad}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {canTopup ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-row">
            <label className="label" htmlFor="credit-topup">
              {t.creditTopupAmount}
            </label>
            <input
              id="credit-topup"
              className="field tabular"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <AsyncButton onClick={topup}>{t.creditTopup}</AsyncButton>
          <CreditOnlineTopup
            ctx={ctx}
            customerId={card.id}
            storeId={data.storeId}
            deviceId={getDeviceBinding()?.deviceId ?? null}
            hasReader={data.hasReader}
            amount={parsePriceInput(amount)}
            amountOk={(() => {
              const v = parsePriceInput(amount);
              return v !== null && v >= 10000 && v <= 5000000 && v + data.balance <= 20000000;
            })()}
            onBadAmount={() => setNote('topupBad')}
            onCredited={() => {
              setAmount('');
              setNote('topped');
              reload();
            }}
          />
        </form>
      ) : null}
      <h4>{t.creditHistory}</h4>
      <ul className="member-list">
        {data.history.map((h) => (
          <li key={h.id} className="member-row">
            <div className="member-head">
              <span>{kind(h.kind)}</span>
              <span className="tabular">
                {h.amount > 0 ? '+' : ''}
                {formatTHB(h.amount, locale)}
              </span>
              <span className="muted">{formatDateTime(lang, h.created_at)}</span>
            </div>
            {h.reason ? <p className="muted">{h.reason}</p> : null}
          </li>
        ))}
      </ul>
      {canAdjust ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <h4>{t.creditAdjustTitle}</h4>
          <div className="filters">
            <div className="form-row">
              <label className="label" htmlFor="credit-adj">
                {t.creditAdjustAmount}
              </label>
              <input
                id="credit-adj"
                className="field tabular"
                inputMode="decimal"
                value={adj}
                onChange={(e) => setAdj(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="credit-reason">
                {t.creditAdjustReason}
              </label>
              <input
                id="credit-reason"
                className="field"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <AsyncButton onClick={adjust}>{t.creditAdjustApply}</AsyncButton>
        </form>
      ) : null}
      <p className="muted hint">{fmt(t.custCode, { code: card.memberCode })}</p>
    </section>
  );
}
