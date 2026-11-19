import { useState } from 'react';
import {
  localizedName,
  parsePurchaseOrders,
  parseQty,
  parseSuppliers,
  poActions,
  poOutstanding,
  poTotal,
  priceInputValue,
  splitQty,
} from '@bestie/core';
import type { PurchaseOrder, StockItem, Supplier } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { bigUnit, fromCost1000, toCost1000, tx } from './stockInput';
import { useRemote } from './useRemote';

type Common = {
  ctx: PageContext;
  storeId: string;
  canEdit: boolean;
  fail: (code?: string) => void;
  done: () => void;
};

/** The suppliers a shop orders from. */
export function SuppliersTab({ ctx, storeId, canEdit, fail, done }: Common) {
  const { t } = useI18n();
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    phone: string;
    note: string;
  } | null>(null);
  const [problem, setProblem] = useState(false);
  const data = useRemote<Supplier[]>(async () => {
    const r = await ctx.client
      .from('suppliers')
      .select('id, name, phone, note')
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .order('name');
    if (r.error) throw new Error('load');
    return parseSuppliers(r.data);
  }, storeId);

  const save = async () => {
    if (!form) return;
    setProblem(false);
    if (!form.name.trim()) return setProblem(true);
    const values = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      note: form.note.trim() || null,
    };
    const r = form.id
      ? await ctx.client.from('suppliers').update(values).eq('id', form.id).select('id')
      : await ctx.client
          .from('suppliers')
          .insert({ org_id: ctx.orgId, store_id: storeId, ...values });
    if (r.error) return fail(r.error.code);
    setForm(null);
    data.reload();
    done();
  };
  const remove = async (id: string) => {
    const r = await ctx.client
      .from('suppliers')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');
    if (r.error) return fail(r.error.code);
    data.reload();
    done();
  };

  return (
    <>
      <p className="muted">{t.stockSupplierIntro}</p>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.data && data.data.length === 0 ? <p className="muted">{t.stockSupplierEmpty}</p> : null}
      <ul className="member-list">
        {(data.data ?? []).map((s) => (
          <li key={s.id} className="member-row">
            <div className="member-head">
              <strong>{s.name}</strong>
              {s.phone ? <span className="muted tabular">{s.phone}</span> : null}
            </div>
            {s.note ? <p className="muted">{s.note}</p> : null}
            {canEdit ? (
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setForm({ id: s.id, name: s.name, phone: s.phone ?? '', note: s.note ?? '' })
                  }
                >
                  {t.stockEdit}
                </button>
                <AsyncButton variant="secondary" onClick={() => remove(s.id)}>
                  {t.stockSupplierRemove}
                </AsyncButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {form ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.stockSupplierAdd}
        >
          <div className="form-row">
            <label className="label" htmlFor="sup-name">
              {t.stockSupplierName}
            </label>
            <input
              id="sup-name"
              className="field"
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="sup-phone">
              {t.stockSupplierPhone}
            </label>
            <input
              id="sup-phone"
              className="field tabular"
              maxLength={30}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="sup-note">
              {t.stockSupplierNote}
            </label>
            <input
              id="sup-note"
              className="field"
              maxLength={200}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          {problem ? <Notice kind="error">{t.stockInvalid}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={save}>
              {t.stockSupplierSave}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : canEdit ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setForm({ id: null, name: '', phone: '', note: '' })}
          >
            {t.stockSupplierAdd}
          </button>
        </div>
      ) : null}
    </>
  );
}

type Loaded = { suppliers: Supplier[]; orders: PurchaseOrder[] };
type DraftLine = { itemId: string; qty: string; cost: string };
type Draft = {
  id: string | null;
  supplierId: string;
  expectedOn: string;
  note: string;
  lines: DraftLine[];
};

/** Purchase orders: draft → sent → received (a part delivery is fine). */
export function OrdersTab({
  ctx,
  storeId,
  items,
  canEdit,
  money,
  fail,
  done,
}: Common & { items: StockItem[]; money: (n: number) => string }) {
  const { t, lang } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [receiving, setReceiving] = useState<{
    po: PurchaseOrder;
    qty: Record<string, string>;
  } | null>(null);
  const [problem, setProblem] = useState<ErrorKey | 'lines' | 'nothing' | null>(null);
  const data = useRemote<Loaded>(async () => {
    const [sup, po, lines] = await Promise.all([
      ctx.client
        .from('suppliers')
        .select('id, name, phone, note')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('name'),
      ctx.client
        .from('purchase_orders')
        .select('id, number, supplier_id, status, note, expected_on, created_at')
        .eq('store_id', storeId)
        .order('created_at', { ascending: false })
        .limit(40),
      ctx.client
        .from('purchase_order_lines')
        .select('id, po_id, item_id, qty_ordered, qty_received, cost_per_1000')
        .eq('store_id', storeId),
    ]);
    if (sup.error || po.error || lines.error) throw new Error('load');
    return {
      suppliers: parseSuppliers(sup.data),
      orders: parsePurchaseOrders(po.data, lines.data),
    };
  }, storeId);
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const nameOf = (id: string) => {
    const it = itemOf(id);
    return it ? localizedName(it.name, lang) : '—';
  };
  const qtyText = (n: number, it?: StockItem) => {
    if (!it) return String(n);
    const q = splitQty(n, it.unit);
    return `${q.value} ${tx(t, `stockU_${q.unit}`)}`;
  };
  const supplierName = (id: string) => data.data?.suppliers.find((s) => s.id === id)?.name ?? '—';

  const saveDraft = async () => {
    if (!draft) return;
    setProblem(null);
    const lines: { item_id: string; quantity: number; cost_per_1000: number }[] = [];
    for (const l of draft.lines) {
      const it = itemOf(l.itemId);
      const q = it ? parseQty(l.qty, bigUnit(it.unit)) : null;
      const c = it ? toCost1000(l.cost || '0', it.unit) : null;
      if (!it || q === null || q < 1 || c === null) return setProblem('lines');
      lines.push({ item_id: it.id, quantity: q, cost_per_1000: c });
    }
    if (lines.length === 0 || !draft.supplierId) return setProblem('lines');
    const { error } = await ctx.client.rpc('save_purchase_order', {
      p: {
        id: draft.id,
        store_id: storeId,
        supplier_id: draft.supplierId,
        note: draft.note.trim() || undefined,
        expected_on: draft.expectedOn || undefined,
        lines,
      },
    });
    if (error) return fail(error.code);
    setDraft(null);
    data.reload();
    done();
  };
  const status = async (po: PurchaseOrder, to: 'sent' | 'cancelled') => {
    const { error } = await ctx.client.rpc('set_purchase_order_status', {
      p_po: po.id,
      p_status: to,
    });
    if (error) return fail(error.code);
    data.reload();
    done();
  };
  const receive = async () => {
    if (!receiving) return;
    setProblem(null);
    const lines: { line_id: string; quantity: number }[] = [];
    for (const l of receiving.po.lines) {
      const it = itemOf(l.itemId);
      const text = receiving.qty[l.id] ?? '';
      if (!text.trim() || !it) continue;
      const q = parseQty(text, bigUnit(it.unit));
      if (q === null || q < 0) return setProblem('lines');
      if (q > 0) lines.push({ line_id: l.id, quantity: q });
    }
    if (lines.length === 0) return setProblem('nothing');
    const { error } = await ctx.client.rpc('receive_purchase_order', {
      p: { po_id: receiving.po.id, lines },
    });
    if (error) return fail(error.code);
    setReceiving(null);
    data.reload();
    done();
  };
  const startReceive = (po: PurchaseOrder) => {
    const qty: Record<string, string> = {};
    for (const l of po.lines) {
      const it = itemOf(l.itemId);
      const left = poOutstanding(l);
      if (it && left > 0) qty[l.id] = splitQty(left, it.unit).value;
    }
    setProblem(null);
    setReceiving({ po, qty });
  };
  const startDraft = (po?: PurchaseOrder) => {
    setProblem(null);
    setDraft(
      po
        ? {
            id: po.id,
            supplierId: po.supplierId,
            expectedOn: po.expectedOn ?? '',
            note: po.note ?? '',
            lines: po.lines.map((l) => {
              const it = itemOf(l.itemId);
              return {
                itemId: l.itemId,
                qty: it ? splitQty(l.ordered, it.unit).value : String(l.ordered),
                cost: it ? priceInputValue(fromCost1000(l.costPer1000, it.unit)) : '',
              };
            }),
          }
        : {
            id: null,
            supplierId: data.data?.suppliers[0]?.id ?? '',
            expectedOn: '',
            note: '',
            lines: [{ itemId: items[0]?.id ?? '', qty: '', cost: '' }],
          },
    );
  };
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) =>
      d ? { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : d,
    );

  return (
    <>
      <p className="muted">{t.stockPoIntro}</p>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.data && data.data.orders.length === 0 ? (
        <p className="muted">{t.stockPoEmpty}</p>
      ) : null}
      <ul className="member-list">
        {(data.data?.orders ?? []).map((o) => {
          const can = poActions(o);
          return (
            <li key={o.id} className="member-row">
              <div className="member-head">
                <strong>{o.number}</strong>
                <span className="badge">{tx(t, `stockPoStatus_${o.status}`)}</span>
                <span className="muted">{supplierName(o.supplierId)}</span>
                <span className="tabular">
                  {fmt(t.stockPoTotal, { amount: money(poTotal(o.lines)) })}
                </span>
              </div>
              <ul className="muted">
                {o.lines.map((l) => (
                  <li key={l.id}>
                    {nameOf(l.itemId)} · {qtyText(l.ordered, itemOf(l.itemId))}
                    {l.received > 0
                      ? ` · ${fmt(t.stockPoReceivedQty, {
                          qty: splitQty(l.received, itemOf(l.itemId)?.unit ?? 'pcs').value,
                          unit: tx(
                            t,
                            `stockU_${splitQty(l.received, itemOf(l.itemId)?.unit ?? 'pcs').unit}`,
                          ),
                        })}`
                      : ''}
                    {poOutstanding(l) > 0 && o.status !== 'draft' && o.status !== 'cancelled'
                      ? ` · ${fmt(t.stockPoOutstanding, {
                          qty: splitQty(poOutstanding(l), itemOf(l.itemId)?.unit ?? 'pcs').value,
                          unit: tx(
                            t,
                            `stockU_${splitQty(poOutstanding(l), itemOf(l.itemId)?.unit ?? 'pcs').unit}`,
                          ),
                        })}`
                      : ''}
                  </li>
                ))}
              </ul>
              {canEdit ? (
                <div className="actions">
                  {can.edit ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => startDraft(o)}
                    >
                      {t.stockPoEdit}
                    </button>
                  ) : null}
                  {can.send ? (
                    <AsyncButton variant="secondary" onClick={() => status(o, 'sent')}>
                      {t.stockPoSend}
                    </AsyncButton>
                  ) : null}
                  {can.receive ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => startReceive(o)}
                    >
                      {t.stockPoReceive}
                    </button>
                  ) : null}
                  {can.cancel ? (
                    <AsyncButton variant="secondary" onClick={() => status(o, 'cancelled')}>
                      {t.stockPoCancel}
                    </AsyncButton>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {receiving ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.stockPoReceive}
        >
          <h2>
            {t.stockPoReceive}: {receiving.po.number}
          </h2>
          {receiving.po.lines.map((l) => {
            const it = itemOf(l.itemId);
            return (
              <div key={l.id} className="form-row">
                <label className="label" htmlFor={`rcv-${l.id}`}>
                  {nameOf(l.itemId)} —{' '}
                  {fmt(t.stockPoReceiveNow, {
                    unit: tx(t, `stockU_${bigUnit(it?.unit ?? 'pcs')}`),
                  })}
                </label>
                <input
                  id={`rcv-${l.id}`}
                  className="field tabular"
                  inputMode="decimal"
                  value={receiving.qty[l.id] ?? ''}
                  onChange={(e) =>
                    setReceiving({
                      ...receiving,
                      qty: { ...receiving.qty, [l.id]: e.target.value },
                    })
                  }
                />
              </div>
            );
          })}
          {problem === 'lines' ? <Notice kind="error">{t.stockInvalid}</Notice> : null}
          {problem === 'nothing' ? <Notice kind="error">{t.stockPoNothing}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={receive}>
              {t.stockPoConfirmReceive}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setReceiving(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : null}

      {draft ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.stockPoNew}
        >
          {data.data && data.data.suppliers.length === 0 ? (
            <Notice kind="info">{t.stockPoNeedSupplier}</Notice>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="po-sup">
              {t.stockPoSupplier}
            </label>
            <select
              id="po-sup"
              className="field"
              value={draft.supplierId}
              onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })}
            >
              <option value="">{t.stockPoPickSupplier}</option>
              {(data.data?.suppliers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="po-exp">
              {t.stockPoExpected}
            </label>
            <input
              id="po-exp"
              className="field"
              type="date"
              value={draft.expectedOn}
              onChange={(e) => setDraft({ ...draft, expectedOn: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="po-note">
              {t.stockNote}
            </label>
            <input
              id="po-note"
              className="field"
              maxLength={200}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>
          {draft.lines.map((l, i) => {
            const it = itemOf(l.itemId);
            const unit = tx(t, `stockU_${bigUnit(it?.unit ?? 'pcs')}`);
            return (
              <div key={i} className="filters">
                <div className="form-row">
                  <label className="label" htmlFor={`po-i-${i}`}>
                    {t.stockPoItem}
                  </label>
                  <select
                    id={`po-i-${i}`}
                    className="field"
                    value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value })}
                  >
                    {items.map((x) => (
                      <option key={x.id} value={x.id}>
                        {localizedName(x.name, lang)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label className="label" htmlFor={`po-q-${i}`}>
                    {fmt(t.stockPoQty, { unit })}
                  </label>
                  <input
                    id={`po-q-${i}`}
                    className="field tabular"
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) => setLine(i, { qty: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label className="label" htmlFor={`po-c-${i}`}>
                    {fmt(t.stockPoCost, { unit: tx(t, `stockPer_${it?.unit ?? 'pcs'}`) })}
                  </label>
                  <input
                    id={`po-c-${i}`}
                    className="field tabular"
                    inputMode="decimal"
                    value={l.cost}
                    onChange={(e) => setLine(i, { cost: e.target.value })}
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
                lines: [...draft.lines, { itemId: items[0]?.id ?? '', qty: '', cost: '' }],
              })
            }
          >
            {t.stockPoAddLine}
          </button>
          {problem === 'lines' ? <Notice kind="error">{t.stockPoNoLines}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={saveDraft}>
              {t.stockPoSaveDraft}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : canEdit && !receiving ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={items.length === 0}
            onClick={() => startDraft()}
          >
            {t.stockPoNew}
          </button>
        </div>
      ) : null}
    </>
  );
}
