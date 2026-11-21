import { useState } from 'react';
import {
  DELIVERY_CODES,
  DELIVERY_INTAKE_SAMPLE,
  MAX_COMMISSION_BPS,
  addDays,
  bangkokDate,
  deliveryTotals,
  formatTHB,
  parseDeliveryPlatforms,
  parseDeliveryReport,
} from '@bestie/core';
import type { DeliveryCode } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

type Draft = { id: string | null; code: DeliveryCode; name: string; pct: string; active: boolean };
const baht = (v: string): number => Math.round(Number(v.trim().replace(',', '.')) * 100);

/** Delivery platforms of the shop, their intake tokens, the summary of what each platform kept / owes, and the money they paid out (module `delivery`). */
export function DeliveryPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canReport = ctx.isOwner || ctx.permissions.includes('report.view');
  const canPay = canReport && (ctx.isOwner || ctx.permissions.includes('payment.take'));
  const moduleOn = ctx.isModuleOn ? ctx.isModuleOn('delivery') : true;
  const [from, setFrom] = useState(() => addDays(bangkokDate(Date.now()), -6));
  const [to, setTo] = useState(() => bangkokDate(Date.now()));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [token, setToken] = useState<{ id: string; value: string } | null>(null);
  const [payout, setPayout] = useState<{ id: string; amount: string; ref: string } | null>(null);

  const data = useRemote(async () => {
    if (!storeId) throw new Error('shop');
    const [pl, rep] = await Promise.all([
      ctx.client
        .from('delivery_platforms')
        .select('id, code, name, commission_bps, active, token_hint')
        .eq('store_id', storeId)
        .order('name'),
      canReport
        ? ctx.client.rpc('delivery_report', { p: { store_id: storeId, from, to } })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (pl.error) throw new Error('load');
    return {
      platforms: parseDeliveryPlatforms(pl.data),
      report: rep.error ? [] : parseDeliveryReport(rep.data),
    };
  }, `${storeId}:${from}:${to}:${canReport}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  if (!storeId) return <Notice kind="error">{t.err_load_failed}</Notice>;
  const d = data.data;
  const totals = deliveryTotals(d?.report ?? []);
  const origin = globalThis.location?.origin ?? '';

  const fail = (code?: string) =>
    setMsg({
      kind: 'error',
      text:
        code === '42501'
          ? t.err_forbidden
          : code === '23505'
            ? t.dlDup
            : code === '23514' || code === '22023'
              ? t.dlBad
              : t.err_save_failed,
    });
  const save = async () => {
    if (!draft) return;
    const pct = Number(draft.pct.replace(',', '.'));
    if (!draft.name.trim() || !Number.isFinite(pct) || pct < 0 || pct > MAX_COMMISSION_BPS / 100)
      return setMsg({ kind: 'error', text: t.dlBad });
    setMsg(null);
    const r = await ctx.client.rpc('save_delivery_platform', {
      p: {
        store_id: storeId,
        id: draft.id,
        code: draft.code,
        name: draft.name.trim(),
        commission_bps: Math.round(pct * 100),
        active: draft.active,
      },
    });
    if (r.error) return fail(r.error.code);
    setDraft(null);
    reload();
  };
  const makeToken = (id: string) => async () => {
    setMsg(null);
    const r = await ctx.client.rpc('rotate_delivery_token', { p_platform: id });
    if (r.error) return fail(r.error.code);
    if (typeof r.data === 'string') setToken({ id, value: r.data });
    reload();
  };
  const savePayout = async () => {
    if (!payout) return;
    const satang = baht(payout.amount);
    if (!Number.isFinite(satang) || satang < 1) return setMsg({ kind: 'error', text: t.dlBad });
    setMsg(null);
    const r = await ctx.client.rpc('record_delivery_payout', {
      p: {
        platform_id: payout.id,
        amount: satang,
        period_from: from,
        period_to: to,
        reference: payout.ref.trim() || null,
      },
    });
    if (r.error) return fail(r.error.code);
    setPayout(null);
    setMsg({ kind: 'info', text: t.dlPayoutSaved });
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.dlTitle}</h1>
      <Notice kind="info">{t.dlIntro}</Notice>
      {!moduleOn ? <Notice kind="info">{t.dlOff}</Notice> : null}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      <section className="card admin-card" aria-label={t.dlPlatforms}>
        <h2>{t.dlPlatforms}</h2>
        {d && d.platforms.length === 0 ? <p className="muted">{t.dlNoRows}</p> : null}
        <ul className="member-list">
          {(d?.platforms ?? []).map((p) => (
            <li key={p.id} className="member-row">
              <div className="member-head">
                <strong>{p.name}</strong>
                <span className="muted">{tx(t, `dlCode_${p.code}`)}</span>
                <span className="badge">{p.commissionBps / 100}%</span>
                {!p.active ? <span className="muted">—</span> : null}
              </div>
              <p className="muted">
                {p.tokenHint ? fmt(t.dlTokenHint, { hint: p.tokenHint }) : t.dlTokenNone}
              </p>
              {token?.id === p.id ? (
                <div className="card" role="status">
                  <p>
                    <strong>{t.dlTokenShown}</strong>
                  </p>
                  <input
                    className="field mono"
                    readOnly
                    aria-label={t.dlTokenMake}
                    value={token.value}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <p className="muted">{t.dlEndpoint}</p>
                  <code className="mono">{`POST ${origin}/api/delivery/intake`}</code>
                  <p className="muted">{t.dlSample}</p>
                  <pre className="mono">{JSON.stringify(DELIVERY_INTAKE_SAMPLE, null, 2)}</pre>
                </div>
              ) : null}
              {canEdit ? (
                <div className="actions">
                  <AsyncButton
                    variant="secondary"
                    onClick={async () =>
                      setDraft({
                        id: p.id,
                        code: p.code,
                        name: p.name,
                        pct: String(p.commissionBps / 100),
                        active: p.active,
                      })
                    }
                  >
                    {t.dlSave}
                  </AsyncButton>
                  <AsyncButton variant="secondary" onClick={makeToken(p.id)}>
                    {t.dlTokenMake}
                  </AsyncButton>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit ? (
          draft ? (
            <form className="auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.dlAdd}>
              <div className="form-row">
                <label className="label" htmlFor="dl-name">
                  {t.dlName}
                </label>
                <input
                  id="dl-name"
                  className="field"
                  maxLength={40}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="dl-code">
                  {t.dlCode}
                </label>
                <select
                  id="dl-code"
                  className="field"
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value as DeliveryCode })}
                >
                  {DELIVERY_CODES.map((c) => (
                    <option key={c} value={c}>
                      {tx(t, `dlCode_${c}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label className="label" htmlFor="dl-pct">
                  {t.dlCommission}
                </label>
                <input
                  id="dl-pct"
                  className="field"
                  inputMode="decimal"
                  value={draft.pct}
                  onChange={(e) => setDraft({ ...draft, pct: e.target.value })}
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                />{' '}
                {t.dlActive}
              </label>
              <div className="actions">
                <AsyncButton type="submit" onClick={save}>
                  {t.dlSave}
                </AsyncButton>
                <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
                  {t.menuCancel}
                </button>
              </div>
            </form>
          ) : (
            <div className="actions">
              <AsyncButton
                variant="secondary"
                onClick={async () =>
                  setDraft({ id: null, code: 'lineman', name: '', pct: '30', active: true })
                }
              >
                {t.dlAdd}
              </AsyncButton>
            </div>
          )
        ) : null}
      </section>

      {canReport ? (
        <section className="card admin-card" aria-label={t.dlReport}>
          <h2>{t.dlReport}</h2>
          <div className="form-row">
            <label className="label" htmlFor="dl-from">
              {t.dlFrom}
            </label>
            <input
              id="dl-from"
              className="field"
              type="date"
              value={from}
              max={to}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
            />
            <label className="label" htmlFor="dl-to">
              {t.dlTo}
            </label>
            <input
              id="dl-to"
              className="field"
              type="date"
              value={to}
              min={from}
              onChange={(e) => e.target.value && setTo(e.target.value)}
            />
          </div>
          <table className="folio-lines">
            <thead>
              <tr>
                <th>{t.dlvPlatform}</th>
                <th>{t.dlBills}</th>
                <th>{t.dlGross}</th>
                <th>{t.dlCommissionCol}</th>
                <th>{t.dlNet}</th>
                <th>{t.dlPaidOut}</th>
                <th>{t.dlOwed}</th>
              </tr>
            </thead>
            <tbody>
              {(d?.report ?? []).map((r) => (
                <tr key={r.platformId}>
                  <td>{r.name}</td>
                  <td className="tabular">{r.bills}</td>
                  <td className="tabular">{money(r.gross)}</td>
                  <td className="tabular">{money(r.commission)}</td>
                  <td className="tabular">{money(r.net)}</td>
                  <td className="tabular">{money(r.paidOut)}</td>
                  <td className="tabular">{money(r.owed)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th />
                <th className="tabular">{totals.bills}</th>
                <th className="tabular">{money(totals.gross)}</th>
                <th className="tabular">{money(totals.commission)}</th>
                <th className="tabular">{money(totals.net)}</th>
                <th className="tabular">{money(totals.paidOut)}</th>
                <th className="tabular">{money(totals.owed)}</th>
              </tr>
            </tfoot>
          </table>
          {canPay ? (
            payout ? (
              <form
                className="auth-form"
                onSubmit={(e) => e.preventDefault()}
                aria-label={t.dlPayout}
              >
                <div className="form-row">
                  <label className="label" htmlFor="dl-pay-platform">
                    {t.dlvPlatform}
                  </label>
                  <select
                    id="dl-pay-platform"
                    className="field"
                    value={payout.id}
                    onChange={(e) => setPayout({ ...payout, id: e.target.value })}
                  >
                    {(d?.platforms ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label className="label" htmlFor="dl-pay-amount">
                    {t.dlPayoutAmount}
                  </label>
                  <input
                    id="dl-pay-amount"
                    className="field"
                    inputMode="decimal"
                    value={payout.amount}
                    onChange={(e) => setPayout({ ...payout, amount: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label className="label" htmlFor="dl-pay-ref">
                    {t.dlPayoutRef}
                  </label>
                  <input
                    id="dl-pay-ref"
                    className="field"
                    maxLength={100}
                    value={payout.ref}
                    onChange={(e) => setPayout({ ...payout, ref: e.target.value })}
                  />
                </div>
                <div className="actions">
                  <AsyncButton type="submit" onClick={savePayout}>
                    {t.dlPayoutSave}
                  </AsyncButton>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setPayout(null)}
                  >
                    {t.menuCancel}
                  </button>
                </div>
              </form>
            ) : (d?.platforms.length ?? 0) > 0 ? (
              <div className="actions">
                <AsyncButton
                  variant="secondary"
                  onClick={async () =>
                    setPayout({ id: d?.platforms[0]?.id ?? '', amount: '', ref: '' })
                  }
                >
                  {t.dlPayout}
                </AsyncButton>
              </div>
            ) : null
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
