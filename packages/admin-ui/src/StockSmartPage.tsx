import { useState } from 'react';
import {
  bangkokDate,
  daysToExpiry,
  formatTHB,
  groupSuggestions,
  guestName,
  parseBatches,
  parseCostAlerts,
  parseForecast,
  parseWaste,
  WASTE_REASONS,
} from '@bestie/core';
import type { LocalizedText } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Tab = 'forecast' | 'waste' | 'lots' | 'cost' | 'prices';
const addDays = (d: string, n: number): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
type Price = { item_id: string; supplier_name: string; cost_per_1000: number };

/** Smart stock: what to order (forecast), waste by reason, lots with a date of expiry, dishes whose cost rose, supplier prices (needs `stock.view`; ordering and lots need `stock.manage`). */
export function StockSmartPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canView =
    ctx.isOwner ||
    ctx.permissions.some(
      (p) => p === 'stock.view' || p === 'stock.manage' || p === 'menu.edit' || p === 'report.view',
    );
  const canManage = ctx.isOwner || ctx.permissions.includes('stock.manage');
  const [tab, setTab] = useState<Tab>('forecast');
  const [msg, setMsg] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [lot, setLot] = useState({ item: '', qty: '', exp: '', code: '' });
  const reasons: Record<string, string> = {
    expired: t.siReason_expired,
    damaged: t.siReason_damaged,
    overproduced: t.siReason_overproduced,
    spilled: t.siReason_spilled,
    returned: t.siReason_returned,
    other: t.siReason_other,
  };
  const [today] = useState(() => bangkokDate(Date.now()));

  const data = useRemote(async () => {
    if (!canView || !storeId) throw new Error('forbidden');
    const [fc, waste, lots, cost, prices, items] = await Promise.all([
      ctx.client.rpc('stock_forecast', { p: { store_id: storeId, horizon: 7, lead: 2 } }),
      ctx.client.rpc('waste_report', {
        p: { store_id: storeId, from: addDays(today, -29), to: today },
      }),
      ctx.client
        .from('stock_batches')
        .select('id, item_id, code, qty, expires_on, note, used_at')
        .eq('store_id', storeId)
        .order('expires_on'),
      ctx.client.rpc('cost_alerts', { p: { store_id: storeId } }),
      ctx.client.rpc('supplier_prices', { p: { store_id: storeId } }),
      ctx.client
        .from('stock_items')
        .select('id, name, unit')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('created_at'),
    ]);
    if (fc.error || items.error) throw new Error('load');
    return {
      fc: parseForecast(fc.data),
      waste: parseWaste(waste.data),
      lots: parseBatches(lots.data),
      cost: parseCostAlerts(cost.data),
      prices: (Array.isArray(prices.data) ? prices.data : []) as Price[],
      items: (items.data ?? []) as { id: string; name: LocalizedText; unit: string }[],
    };
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;
  const itemName = (id: string) => {
    const i = d?.items.find((x) => x.id === id);
    return i ? guestName(i.name, lang) : '…';
  };

  if (!canView)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.siNoAccess}</Notice>
      </div>
    );

  const makeDrafts = async () => {
    if (!d || !storeId) return;
    setMsg(null);
    const g = groupSuggestions(d.fc);
    let n = 0;
    for (const s of g.bySupplier) {
      const r = await ctx.client.rpc('save_purchase_order', {
        p: {
          store_id: storeId,
          supplier_id: s.supplierId,
          note: 'Smart stock',
          lines: s.lines.map((l) => ({
            item_id: l.item_id,
            quantity: l.quantity,
            cost_per_1000: l.cost_per_1000,
          })),
        },
      });
      if (r.error)
        return setMsg({
          kind: 'error',
          text: r.error.code === '42501' ? t.err_forbidden : t.err_save_failed,
        });
      n += 1;
    }
    const parts: string[] = [];
    if (n > 0) parts.push(fmt(t.siDrafted, { n }));
    if (g.noSupplier.length > 0)
      parts.push(
        fmt(t.siNoSupplier, { names: g.noSupplier.map((r) => guestName(r.name, lang)).join(', ') }),
      );
    setMsg({ kind: n > 0 ? 'success' : 'info', text: parts.join(' ') || t.siNothing });
  };
  const addLot = async () => {
    setMsg(null);
    const qty = Number(lot.qty);
    if (!lot.item || !Number.isInteger(qty) || qty < 1 || !lot.exp)
      return setMsg({ kind: 'error', text: t.err_save_failed });
    const r = await ctx.client.rpc('save_stock_batch', {
      p: { item_id: lot.item, qty, expires_on: lot.exp, code: lot.code || null },
    });
    if (r.error)
      return setMsg({
        kind: 'error',
        text: r.error.code === '42501' ? t.err_forbidden : t.err_save_failed,
      });
    setLot({ item: '', qty: '', exp: '', code: '' });
    reload();
  };
  const closeLot = async (id: string) => {
    const r = await ctx.client.rpc('close_stock_batch', { p_id: id });
    if (r.error) return setMsg({ kind: 'error', text: t.err_save_failed });
    reload();
  };
  const tabs: [Tab, string][] = [
    ['forecast', t.siTabForecast],
    ['waste', t.siTabWaste],
    ['lots', t.siTabLots],
    ['cost', t.siTabCost],
    ['prices', t.siTabPrices],
  ];
  const need = (d?.fc ?? []).filter((r) => r.suggested > 0);
  return (
    <div className="admin-page">
      <h1>{t.siTitle}</h1>
      <Notice kind="info">{t.siIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <div className="chips" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="chip"
            aria-selected={tab === id}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      {d && tab === 'forecast' ? (
        <section className="card admin-card" aria-label={t.siTabForecast}>
          <p className="muted">{fmt(t.siHorizon, { days: 7, lead: 2 })}</p>
          {need.length === 0 ? (
            <p className="muted">{d.fc.some((r) => r.avgDaily > 0) ? t.siNothing : t.siNoSales}</p>
          ) : null}
          {need.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  {[
                    t.siItem,
                    t.siOnHand,
                    t.siPerDay,
                    t.siDaysLeft,
                    t.siOnOrder,
                    t.siNeed,
                    t.siSuggest,
                    t.siSupplier,
                  ].map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {need.map((r) => (
                  <tr key={r.itemId}>
                    <td>{guestName(r.name, lang)}</td>
                    <td className="tabular">
                      {r.quantity} {r.unit}
                    </td>
                    <td className="tabular">{r.avgDaily}</td>
                    <td className="tabular">{r.daysLeft ?? '—'}</td>
                    <td className="tabular">{r.onOrder}</td>
                    <td className="tabular">{r.forecast}</td>
                    <td className="tabular">
                      <strong>{r.suggested}</strong>
                    </td>
                    <td>{r.supplierName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {canManage && need.length > 0 ? (
            <div className="actions">
              <AsyncButton onClick={makeDrafts}>{t.siMakeDrafts}</AsyncButton>
            </div>
          ) : null}
        </section>
      ) : null}

      {d && tab === 'waste' ? (
        <section className="card admin-card" aria-label={t.siTabWaste}>
          {d.waste.total === 0 ? <p className="muted">{t.siWasteNone}</p> : null}
          {d.waste.total > 0 ? (
            <>
              <p>
                {t.siWasteTotal}: <strong className="tabular">{money(d.waste.total)}</strong>
              </p>
              <h2>{t.siWasteByReason}</h2>
              <ul>
                {d.waste.byReason.map((r) => (
                  <li key={r.reason}>
                    {reasons[r.reason]}: <span className="tabular">{money(r.cost)}</span>
                  </li>
                ))}
              </ul>
              <h2>{t.siWasteByItem}</h2>
              <ul>
                {d.waste.byItem.map((r) => (
                  <li key={r.itemId}>
                    {guestName(r.name, lang)}: {r.qty} {r.unit} ·{' '}
                    <span className="tabular">{money(r.cost)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="muted">{WASTE_REASONS.map((r) => reasons[r]).join(' · ')}</p>
        </section>
      ) : null}

      {d && tab === 'lots' ? (
        <section className="card admin-card" aria-label={t.siTabLots}>
          <p className="muted">{t.siLotNote}</p>
          {d.lots.length === 0 ? <p className="muted">{t.siLotNone}</p> : null}
          <ul className="member-list">
            {d.lots.map((b) => {
              const n = daysToExpiry(b.expiresOn, today);
              return (
                <li key={b.id} className="member-row">
                  <strong>{itemName(b.itemId)}</strong> · {b.qty} {b.code ? `· ${b.code}` : ''} ·{' '}
                  {b.expiresOn} ·{' '}
                  <span className={n < 0 ? 'badge badge-danger' : 'badge'}>
                    {n < 0 ? t.siLotExpired : fmt(t.siLotDays, { n })}
                  </span>
                  {canManage ? (
                    <AsyncButton variant="secondary" onClick={() => closeLot(b.id)}>
                      {t.siLotUse}
                    </AsyncButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canManage ? (
            <form
              className="auth-form"
              onSubmit={(e) => e.preventDefault()}
              aria-label={t.siLotNew}
            >
              <h2>{t.siLotNew}</h2>
              <div className="form-row">
                <label className="label" htmlFor="lot-item">
                  {t.siLotItem}
                </label>
                <select
                  id="lot-item"
                  className="field"
                  value={lot.item}
                  onChange={(e) => setLot({ ...lot, item: e.target.value })}
                >
                  <option value="">—</option>
                  {d.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {guestName(i.name, lang)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label className="label" htmlFor="lot-qty">
                  {t.siLotQty}
                </label>
                <input
                  id="lot-qty"
                  className="field"
                  inputMode="numeric"
                  value={lot.qty}
                  onChange={(e) => setLot({ ...lot, qty: e.target.value.replace(/\D/g, '') })}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="lot-exp">
                  {t.siLotExp}
                </label>
                <input
                  id="lot-exp"
                  className="field"
                  type="date"
                  value={lot.exp}
                  onChange={(e) => setLot({ ...lot, exp: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="lot-code">
                  {t.siLotCode}
                </label>
                <input
                  id="lot-code"
                  className="field"
                  maxLength={40}
                  value={lot.code}
                  onChange={(e) => setLot({ ...lot, code: e.target.value })}
                />
              </div>
              <div className="actions">
                <AsyncButton type="submit" onClick={addLot}>
                  {t.siLotSave}
                </AsyncButton>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      {d && tab === 'cost' ? (
        <section className="card admin-card" aria-label={t.siTabCost}>
          {d.cost.length === 0 ? <p className="muted">{t.siCostNone}</p> : null}
          <ul>
            {d.cost.map((c) => (
              <li key={c.itemId}>
                <strong>{guestName(c.name, lang)}</strong>:{' '}
                {fmt(t.siCostRow, {
                  before: money(c.costBefore),
                  now: money(c.costNow),
                  price: money(c.price),
                  margin: c.marginBps === null ? '—' : `${Math.round(c.marginBps / 100)}%`,
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d && tab === 'prices' ? (
        <section className="card admin-card" aria-label={t.siTabPrices}>
          {d.prices.length === 0 ? <p className="muted">{t.siPricesNone}</p> : null}
          <ul>
            {[...new Set(d.prices.map((p) => p.item_id))].map((id) => {
              const rows = d.prices.filter((p) => p.item_id === id);
              const best = Math.min(...rows.map((r) => Number(r.cost_per_1000)));
              return (
                <li key={id}>
                  <strong>{itemName(id)}</strong>:{' '}
                  {rows.map((r) => (
                    <span key={r.supplier_name} className="badge">
                      {r.supplier_name} {money(Number(r.cost_per_1000))}
                      {Number(r.cost_per_1000) === best && rows.length > 1
                        ? ` · ${t.siPriceBest}`
                        : ''}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
