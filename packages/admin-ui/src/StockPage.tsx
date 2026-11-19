import { useState } from 'react';
import {
  dishCost,
  formatPctX10,
  formatTHB,
  inputUnitsFor,
  isLow,
  lineCost,
  localizedName,
  margin,
  parseQty,
  parseRecipeLines,
  parseStockItems,
  parsePriceInput,
  priceBeforeVat,
  priceInputValue,
  splitQty,
  STOCK_UNITS,
} from '@bestie/core';
import type { InputUnit, StockItem, StockUnit } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Tab = 'items' | 'recipes' | 'history';
type MenuRow = { id: string; name: { th: string; en?: string }; prices: { base?: number } };
type Move = {
  id: string;
  item_id: string;
  kind: string;
  qty_delta: number;
  note: string | null;
  created_at: string;
};
type Loaded = {
  items: StockItem[];
  recipes: ReturnType<typeof parseRecipeLines>;
  menu: MenuRow[];
  moves: Move[];
  vat: { vatBps: number; inclusive: boolean };
};
const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;
const KINDS = ['receive', 'waste', 'adjust', 'count'] as const;

/** Satang per 1,000 base units from what a person types: per kg / litre, or per piece. */
const toCost1000 = (text: string, unit: StockUnit): number | null => {
  const v = parsePriceInput(text);
  return v === null ? null : unit === 'pcs' ? v * 1000 : v;
};
const fromCost1000 = (c: number, unit: StockUnit): number =>
  unit === 'pcs' ? Math.round(c / 1000) : c;

/** Stock on hand, goods in / waste / counts, recipes with cost and margin. Needs menu.edit (or report.view to look). */
export function StockPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canSee = canEdit || ctx.permissions.includes('report.view');
  const [tab, setTab] = useState<Tab>('items');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const data = useRemote<Loaded>(
    async () => {
      if (!storeId) throw new Error('shop');
      const [items, recipes, menu, moves, store] = await Promise.all([
        ctx.client
          .from('stock_items')
          .select('*')
          .eq('store_id', storeId)
          .is('deleted_at', null)
          .order('created_at'),
        ctx.client
          .from('recipe_lines')
          .select('menu_item_id, item_id, quantity')
          .eq('store_id', storeId),
        ctx.client
          .from('menu_items')
          .select('id, name, prices')
          .eq('store_id', storeId)
          .is('deleted_at', null)
          .order('sort'),
        ctx.client
          .from('stock_moves')
          .select('id, item_id, kind, qty_delta, note, created_at')
          .eq('store_id', storeId)
          .order('created_at', { ascending: false })
          .limit(60),
        ctx.client
          .from('stores')
          .select('vat_registered, vat_bps, price_mode')
          .eq('id', storeId)
          .maybeSingle(),
      ]);
      if (items.error || recipes.error || menu.error || moves.error) throw new Error('load');
      const st = (store.data ?? {}) as {
        vat_registered?: boolean;
        vat_bps?: number;
        price_mode?: string;
      };
      return {
        items: parseStockItems(items.data),
        recipes: parseRecipeLines(recipes.data),
        menu: (menu.data ?? []) as MenuRow[],
        moves: (moves.data ?? []) as Move[],
        vat: {
          vatBps: st.vat_registered ? (st.vat_bps ?? 0) : 0,
          inclusive: st.price_mode !== 'exclusive',
        },
      };
    },
    `${storeId ?? ''}`,
  );

  if (!canSee)
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_forbidden', t)}</Notice>
      </div>
    );
  const d = data.data;
  const fail = (code?: string) => setError(code === '42501' ? 'err_forbidden' : 'err_save_failed');
  const done = () => {
    setError(null);
    setNote(t.stockSaved);
    data.reload();
  };
  const nameOf = (id: string) => {
    const it = d?.items.find((i) => i.id === id);
    return it ? localizedName(it.name, lang) : '—';
  };

  return (
    <div className="admin-page">
      <h1>{t.stockTitle}</h1>
      <Notice kind="info">{t.stockIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}
      <div className="tabs" role="tablist">
        {(['items', 'recipes', 'history'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {tx(t, `stockTab_${k}`)}
          </button>
        ))}
      </div>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d && tab === 'items' ? (
        <ItemsTab
          ctx={ctx}
          d={d}
          storeId={storeId!}
          canEdit={canEdit}
          money={money}
          fail={fail}
          done={done}
        />
      ) : null}
      {d && tab === 'recipes' ? (
        <RecipesTab
          ctx={ctx}
          d={d}
          storeId={storeId!}
          canEdit={canEdit}
          money={money}
          fail={fail}
          done={done}
        />
      ) : null}
      {d && tab === 'history' ? (
        <>
          {d.moves.length === 0 ? <p className="muted">{t.stockHistoryEmpty}</p> : null}
          <ul className="member-list">
            {d.moves.map((m) => {
              const it = d.items.find((i) => i.id === m.item_id);
              const q = it
                ? splitQty(Math.abs(m.qty_delta), it.unit)
                : { value: String(Math.abs(m.qty_delta)), unit: 'g' as InputUnit };
              return (
                <li key={m.id} className="member-row">
                  <strong>{nameOf(m.item_id)}</strong>{' '}
                  <span className="tabular">
                    {m.qty_delta < 0 ? '−' : '+'}
                    {q.value} {tx(t, `stockU_${q.unit}`)}
                  </span>{' '}
                  <span className="badge">{tx(t, `stockKind_${m.kind}`)}</span>
                  <p className="muted">
                    {new Intl.DateTimeFormat(locale, {
                      timeZone: 'Asia/Bangkok',
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(m.created_at))}
                    {m.note ? ` · ${m.note}` : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

type Common = {
  ctx: PageContext;
  d: Loaded;
  storeId: string;
  canEdit: boolean;
  money: (n: number) => string;
  fail: (code?: string) => void;
  done: () => void;
};

function ItemsTab({ ctx, d, storeId, canEdit, money, fail, done }: Common) {
  const { t, lang } = useI18n();
  const [form, setForm] = useState<{
    id: string | null;
    th: string;
    en: string;
    unit: StockUnit;
    cost: string;
    low: string;
  } | null>(null);
  const [mv, setMv] = useState<{
    item: StockItem;
    kind: (typeof KINDS)[number];
    qty: string;
    unit: InputUnit;
    cost: string;
    note: string;
  } | null>(null);
  const [problem, setProblem] = useState(false);

  const saveItem = async () => {
    if (!form) return;
    setProblem(false);
    const cost = toCost1000(form.cost || '0', form.unit);
    const inputUnit = inputUnitsFor(form.unit)[0]!;
    const low = parseQty(
      form.low || '0',
      form.unit === 'g' ? 'kg' : form.unit === 'ml' ? 'l' : 'pcs',
    );
    if (!form.th.trim() || cost === null || low === null) return setProblem(true);
    void inputUnit;
    const values = {
      name: { th: form.th.trim(), ...(form.en.trim() ? { en: form.en.trim() } : {}) },
      unit: form.unit,
      cost_per_1000: cost,
      low_at: low,
    };
    const r = form.id
      ? await ctx.client.from('stock_items').update(values).eq('id', form.id).select('id')
      : await ctx.client
          .from('stock_items')
          .insert({ org_id: ctx.orgId, store_id: storeId, ...values });
    if (r.error) return fail(r.error.code);
    setForm(null);
    done();
  };
  const saveMove = async () => {
    if (!mv) return;
    setProblem(false);
    const q = parseQty(mv.qty, mv.unit);
    if (q === null || (mv.kind !== 'adjust' && q < 0)) return setProblem(true);
    const cost = mv.kind === 'receive' && mv.cost.trim() ? toCost1000(mv.cost, mv.item.unit) : null;
    const { error } = await ctx.client.rpc('stock_move', {
      p: {
        item_id: mv.item.id,
        kind: mv.kind,
        quantity: q,
        ...(cost !== null ? { cost_per_1000: cost } : {}),
        note: mv.note.trim() || undefined,
      },
    });
    if (error) return fail(error.code);
    setMv(null);
    done();
  };

  return (
    <>
      {d.items.length === 0 ? <p className="muted">{t.stockEmpty}</p> : null}
      <ul className="member-list">
        {d.items.map((i) => {
          const q = splitQty(i.quantity, i.unit);
          return (
            <li key={i.id} className="member-row">
              <div className="member-head">
                <strong>{localizedName(i.name, lang)}</strong>
                <span className="tabular">
                  {q.value} {tx(t, `stockU_${q.unit}`)}
                </span>
                {i.quantity < 0 ? (
                  <span className="badge">{t.stockNegative}</span>
                ) : isLow(i) ? (
                  <span className="badge">{t.stockLow}</span>
                ) : null}
              </div>
              <p className="muted">
                {fmt(t.stockCostPer, {
                  amount: money(fromCost1000(i.costPer1000, i.unit)),
                  unit: tx(t, `stockPer_${i.unit}`),
                })}
              </p>
              {canEdit ? (
                <div className="actions">
                  {KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        setMv({
                          item: i,
                          kind: k,
                          qty: '',
                          unit: inputUnitsFor(i.unit)[inputUnitsFor(i.unit).length - 1]!,
                          cost: '',
                          note: '',
                        })
                      }
                    >
                      {tx(t, `stockKind_${k}`)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      const low = splitQty(i.lowAt, i.unit);
                      setForm({
                        id: i.id,
                        th: i.name.th,
                        en: i.name.en ?? '',
                        unit: i.unit,
                        cost: priceInputValue(fromCost1000(i.costPer1000, i.unit)),
                        low: low.value,
                      });
                    }}
                  >
                    {t.stockEdit}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {mv ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={tx(t, `stockKind_${mv.kind}`)}
        >
          <h2>
            {tx(t, `stockKind_${mv.kind}`)}: {localizedName(mv.item.name, lang)}
          </h2>
          <p className="muted">{tx(t, `stockKindNote_${mv.kind}`)}</p>
          <div className="form-row">
            <label className="label" htmlFor="mv-qty">
              {t.stockQty}
            </label>
            <input
              id="mv-qty"
              className="field tabular"
              inputMode="decimal"
              value={mv.qty}
              onChange={(e) => setMv({ ...mv, qty: e.target.value })}
            />
            {inputUnitsFor(mv.item.unit).length > 1 ? (
              <select
                aria-label={t.stockUnit}
                className="field"
                value={mv.unit}
                onChange={(e) => setMv({ ...mv, unit: e.target.value as InputUnit })}
              >
                {inputUnitsFor(mv.item.unit).map((u) => (
                  <option key={u} value={u}>
                    {tx(t, `stockU_${u}`)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted">{tx(t, `stockU_${mv.unit}`)}</span>
            )}
          </div>
          {mv.kind === 'receive' ? (
            <div className="form-row">
              <label className="label" htmlFor="mv-cost">
                {fmt(t.stockCostField, { unit: tx(t, `stockPer_${mv.item.unit}`) })}
              </label>
              <input
                id="mv-cost"
                className="field tabular"
                inputMode="decimal"
                value={mv.cost}
                onChange={(e) => setMv({ ...mv, cost: e.target.value })}
              />
            </div>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="mv-note">
              {t.stockNote}
            </label>
            <input
              id="mv-note"
              className="field"
              maxLength={200}
              value={mv.note}
              onChange={(e) => setMv({ ...mv, note: e.target.value })}
            />
          </div>
          {problem ? <Notice kind="error">{t.stockInvalid}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={saveMove}>
              {t.stockSaveMove}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setMv(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : null}
      {form ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.stockAddItem}
        >
          <div className="form-row">
            <label className="label" htmlFor="st-th">
              {t.stockNameTh}
            </label>
            <input
              id="st-th"
              className="field"
              maxLength={80}
              value={form.th}
              onChange={(e) => setForm({ ...form, th: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="st-en">
              {t.stockNameEn}
            </label>
            <input
              id="st-en"
              className="field"
              maxLength={80}
              value={form.en}
              onChange={(e) => setForm({ ...form, en: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="st-unit">
              {t.stockUnit}
            </label>
            <select
              id="st-unit"
              className="field"
              value={form.unit}
              disabled={form.id !== null}
              onChange={(e) => setForm({ ...form, unit: e.target.value as StockUnit })}
            >
              {STOCK_UNITS.map((u) => (
                <option key={u} value={u}>
                  {tx(t, `stockUnit_${u}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="st-cost">
              {fmt(t.stockCostField, { unit: tx(t, `stockPer_${form.unit}`) })}
            </label>
            <input
              id="st-cost"
              className="field tabular"
              inputMode="decimal"
              value={form.cost}
              onChange={(e) => setForm({ ...form, cost: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="st-low">
              {fmt(t.stockLowAt, { unit: tx(t, `stockBig_${form.unit}`) })}
            </label>
            <input
              id="st-low"
              className="field tabular"
              inputMode="decimal"
              value={form.low}
              onChange={(e) => setForm({ ...form, low: e.target.value })}
            />
          </div>
          {problem ? <Notice kind="error">{t.stockInvalid}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={saveItem}>
              {t.stockSaveItem}
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
            onClick={() => setForm({ id: null, th: '', en: '', unit: 'g', cost: '', low: '' })}
          >
            {t.stockAddItem}
          </button>
        </div>
      ) : null}
    </>
  );
}

function RecipesTab({ ctx, d, storeId, canEdit, money, fail, done }: Common) {
  const { t, lang } = useI18n();
  const [dish, setDish] = useState('');
  const [ing, setIng] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<InputUnit>('g');
  const [bad, setBad] = useState(false);
  const menu = d.menu.find((m) => m.id === dish);
  const lines = d.recipes.filter((r) => r.menuItemId === dish);
  const picked = d.items.find((i) => i.id === ing);
  const cost = dishCost(lines, d.items);
  const price = menu?.prices.base ?? 0;
  const net = priceBeforeVat(price, d.vat.vatBps, d.vat.inclusive);
  const m = menu ? margin(net, cost.cost) : null;

  const add = async () => {
    setBad(false);
    const q = parseQty(qty, unit);
    if (!dish || !picked || q === null || q < 1) return setBad(true);
    const { error } = await ctx.client.from('recipe_lines').insert({
      org_id: ctx.orgId,
      store_id: storeId,
      menu_item_id: dish,
      item_id: picked.id,
      quantity: q,
    });
    if (error) return error.code === '23505' ? setBad(true) : fail(error.code);
    setQty('');
    done();
  };
  const remove = async (itemId: string) => {
    const { error } = await ctx.client
      .from('recipe_lines')
      .delete()
      .eq('menu_item_id', dish)
      .eq('item_id', itemId);
    if (error) return fail(error.code);
    done();
  };

  return (
    <>
      <div className="form-row">
        <label className="label" htmlFor="rc-dish">
          {t.stockPickDish}
        </label>
        <select
          id="rc-dish"
          className="field"
          value={dish}
          onChange={(e) => setDish(e.target.value)}
        >
          <option value="">—</option>
          {d.menu.map((x) => (
            <option key={x.id} value={x.id}>
              {localizedName(x.name, lang)}
            </option>
          ))}
        </select>
      </div>
      {menu ? (
        <>
          {lines.length === 0 ? <p className="muted">{t.stockNoRecipe}</p> : null}
          <ul className="member-list">
            {lines.map((l) => {
              const it = d.items.find((i) => i.id === l.itemId);
              const q = it
                ? splitQty(l.quantity, it.unit)
                : { value: String(l.quantity), unit: 'g' as InputUnit };
              return (
                <li key={l.itemId} className="member-row">
                  <strong>{it ? localizedName(it.name, lang) : '—'}</strong>{' '}
                  <span className="tabular">
                    {q.value} {tx(t, `stockU_${q.unit}`)}
                  </span>{' '}
                  <span className="muted tabular">
                    {it ? money(lineCost(l.quantity, it.costPer1000)) : ''}
                  </span>
                  {canEdit ? (
                    <div className="actions">
                      <AsyncButton variant="secondary" onClick={() => remove(l.itemId)}>
                        {t.stockRemoveLine}
                      </AsyncButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <dl className="preview-list tabular">
            <div>
              <dt>{t.stockCostOfDish}</dt>
              <dd>{money(cost.cost)}</dd>
            </div>
            <div>
              <dt>{d.vat.vatBps > 0 && d.vat.inclusive ? t.stockPriceNet : t.stockPrice}</dt>
              <dd>{money(net)}</dd>
            </div>
            {m ? (
              <>
                <div>
                  <dt>{t.stockProfit}</dt>
                  <dd>{money(m.profit)}</dd>
                </div>
                <div>
                  <dt>{t.stockMargin}</dt>
                  <dd>{formatPctX10(m.pctX10)}%</dd>
                </div>
              </>
            ) : null}
          </dl>
          {cost.missing.length > 0 ? (
            <Notice kind="error">{t.stockMissingIngredient}</Notice>
          ) : null}
          {canEdit ? (
            <form
              className="card admin-card auth-form"
              onSubmit={(e) => e.preventDefault()}
              aria-label={t.stockAddLine}
            >
              <div className="form-row">
                <label className="label" htmlFor="rc-ing">
                  {t.stockIngredient}
                </label>
                <select
                  id="rc-ing"
                  className="field"
                  value={ing}
                  onChange={(e) => {
                    setIng(e.target.value);
                    const it = d.items.find((i) => i.id === e.target.value);
                    if (it) setUnit(inputUnitsFor(it.unit)[0]!);
                  }}
                >
                  <option value="">—</option>
                  {d.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {localizedName(i.name, lang)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label className="label" htmlFor="rc-qty">
                  {t.stockPerPortion}
                </label>
                <input
                  id="rc-qty"
                  className="field tabular"
                  inputMode="decimal"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
                {picked && inputUnitsFor(picked.unit).length > 1 ? (
                  <select
                    aria-label={t.stockUnit}
                    className="field"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as InputUnit)}
                  >
                    {inputUnitsFor(picked.unit).map((u) => (
                      <option key={u} value={u}>
                        {tx(t, `stockU_${u}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="muted">{picked ? tx(t, `stockU_${picked.unit}`) : ''}</span>
                )}
              </div>
              {bad ? <Notice kind="error">{t.stockInvalid}</Notice> : null}
              <div className="actions">
                <AsyncButton type="submit" onClick={add}>
                  {t.stockAddLine}
                </AsyncButton>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </>
  );
}
