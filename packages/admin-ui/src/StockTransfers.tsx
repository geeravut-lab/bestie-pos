import { useState } from 'react';
import { localizedName, parseQty, parseTransfers, splitQty, transferActions } from '@bestie/core';
import type { StockItem, StockTransfer } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { bigUnit, tx } from './stockInput';
import { useRemote } from './useRemote';

type Shop = { id: string; name: string };
type Loaded = { shops: Shop[]; transfers: StockTransfer[] };
type DraftLine = { itemId: string; qty: string };

/** Move goods to another shop of the same business: out at once, in when the other shop presses Receive. */
export function TransfersTab({
  ctx,
  storeId,
  items,
  canEdit,
  fail,
  done,
}: {
  ctx: PageContext;
  storeId: string;
  items: StockItem[];
  canEdit: boolean;
  fail: (code?: string) => void;
  done: () => void;
}) {
  const { t, lang } = useI18n();
  const [draft, setDraft] = useState<{ to: string; note: string; lines: DraftLine[] } | null>(null);
  const [problem, setProblem] = useState(false);
  const data = useRemote<Loaded>(async () => {
    const [shops, tr, lines] = await Promise.all([
      ctx.client.from('stores').select('id, name').eq('org_id', ctx.orgId).is('deleted_at', null),
      ctx.client
        .from('stock_transfers')
        .select('id, number, from_store_id, to_store_id, status, note, created_at')
        .or(`from_store_id.eq.${storeId},to_store_id.eq.${storeId}`)
        .order('created_at', { ascending: false })
        .limit(40),
      ctx.client
        .from('stock_transfer_lines')
        .select('id, transfer_id, from_item_id, quantity, cost_per_1000'),
    ]);
    if (shops.error || tr.error || lines.error) throw new Error('load');
    return {
      shops: ((shops.data ?? []) as Shop[]).filter((s) => typeof s.id === 'string'),
      transfers: parseTransfers(tr.data, lines.data),
    };
  }, storeId);
  const others = (data.data?.shops ?? []).filter((s) => s.id !== storeId);
  const shopName = (id: string) => data.data?.shops.find((s) => s.id === id)?.name ?? '—';
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const qtyText = (n: number, it?: StockItem) => {
    if (!it) return String(n);
    const q = splitQty(n, it.unit);
    return `${q.value} ${tx(t, `stockU_${q.unit}`)}`;
  };

  const send = async () => {
    if (!draft) return;
    setProblem(false);
    const lines: { item_id: string; quantity: number }[] = [];
    for (const l of draft.lines) {
      const it = itemOf(l.itemId);
      const q = it ? parseQty(l.qty, bigUnit(it.unit)) : null;
      if (!it || q === null || q < 1 || q > it.quantity) return setProblem(true);
      lines.push({ item_id: it.id, quantity: q });
    }
    if (lines.length === 0 || !draft.to) return setProblem(true);
    const { error } = await ctx.client.rpc('send_stock_transfer', {
      p: {
        from_store_id: storeId,
        to_store_id: draft.to,
        note: draft.note.trim() || undefined,
        lines,
      },
    });
    if (error) return fail(error.code);
    setDraft(null);
    data.reload();
    done();
  };
  const receive = async (tr: StockTransfer) => {
    const { error } = await ctx.client.rpc('receive_stock_transfer', {
      p: { transfer_id: tr.id },
    });
    if (error) return fail(error.code);
    data.reload();
    done();
  };
  const cancel = async (tr: StockTransfer) => {
    const { error } = await ctx.client.rpc('cancel_stock_transfer', { p_transfer: tr.id });
    if (error) return fail(error.code);
    data.reload();
    done();
  };
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) =>
      d ? { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : d,
    );

  return (
    <>
      <p className="muted">{t.stockTrIntro}</p>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.data && data.data.transfers.length === 0 ? (
        <p className="muted">{t.stockTrEmpty}</p>
      ) : null}
      <ul className="member-list">
        {(data.data?.transfers ?? []).map((tr) => {
          const side = tr.toStoreId === storeId ? 'to' : 'from';
          const can = transferActions(tr, side);
          return (
            <li key={tr.id} className="member-row">
              <div className="member-head">
                <strong>{tr.number}</strong>
                <span className="badge">{tx(t, `stockTrStatus_${tr.status}`)}</span>
                <span className="muted">
                  {side === 'from'
                    ? fmt(t.stockTrOut, { shop: shopName(tr.toStoreId) })
                    : fmt(t.stockTrIn, { shop: shopName(tr.fromStoreId) })}
                </span>
              </div>
              <ul className="muted">
                {tr.lines.map((l) => {
                  const it = itemOf(l.fromItemId);
                  return (
                    <li key={l.id}>
                      {it ? localizedName(it.name, lang) : '—'} · {qtyText(l.quantity, it)}
                    </li>
                  );
                })}
              </ul>
              {canEdit && (can.receive || can.cancel) ? (
                <div className="actions">
                  {can.receive ? (
                    <AsyncButton onClick={() => receive(tr)}>{t.stockTrReceive}</AsyncButton>
                  ) : null}
                  {can.cancel ? (
                    <AsyncButton variant="secondary" onClick={() => cancel(tr)}>
                      {t.stockTrCancel}
                    </AsyncButton>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {draft ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.stockTrNew}
        >
          <div className="form-row">
            <label className="label" htmlFor="tr-to">
              {t.stockTrTo}
            </label>
            <select
              id="tr-to"
              className="field"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            >
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="tr-note">
              {t.stockNote}
            </label>
            <input
              id="tr-note"
              className="field"
              maxLength={200}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>
          {draft.lines.map((l, i) => {
            const it = itemOf(l.itemId);
            return (
              <div key={i} className="filters">
                <div className="form-row">
                  <label className="label" htmlFor={`tr-i-${i}`}>
                    {t.stockPoItem}
                  </label>
                  <select
                    id={`tr-i-${i}`}
                    className="field"
                    value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value })}
                  >
                    {items.map((x) => (
                      <option key={x.id} value={x.id}>
                        {localizedName(x.name, lang)} ({qtyText(x.quantity, x)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label className="label" htmlFor={`tr-q-${i}`}>
                    {t.stockQty} ({tx(t, `stockU_${bigUnit(it?.unit ?? 'pcs')}`)})
                  </label>
                  <input
                    id={`tr-q-${i}`}
                    className="field tabular"
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) => setLine(i, { qty: e.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={t.stockRemoveLine}
                  onClick={() =>
                    setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })
                  }
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              setDraft({
                ...draft,
                lines: [...draft.lines, { itemId: items[0]?.id ?? '', qty: '' }],
              })
            }
          >
            {t.stockPoAddLine}
          </button>
          {problem ? <Notice kind="error">{t.stockTrNotEnough}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={send}>
              {t.stockTrSend}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : canEdit ? (
        others.length === 0 && data.data ? (
          <Notice kind="info">{t.stockTrNoOther}</Notice>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={items.length === 0 || others.length === 0}
              onClick={() => {
                setProblem(false);
                setDraft({
                  to: others[0]?.id ?? '',
                  note: '',
                  lines: [{ itemId: items[0]?.id ?? '', qty: '' }],
                });
              }}
            >
              {t.stockTrNew}
            </button>
          </div>
        )
      ) : null}
    </>
  );
}
