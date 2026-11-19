import { useState } from 'react';
import { localizedName, parseOptionUse, parseQty, splitQty } from '@bestie/core';
import type { OptionUse, StockItem } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

type Name = { th: string; en?: string };
type Group = { id: string; name: Name; options: { id: string; name: Name }[] };
type Loaded = { groups: Group[]; uses: OptionUse[] };

/** Link menu options (oat milk, extra shot) to the ingredients they use; "instead of" replaces a recipe ingredient. */
export function OptionsTab({
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
  const [form, setForm] = useState<{
    optionId: string;
    itemId: string;
    qty: string;
    insteadOf: string;
  } | null>(null);
  const [bad, setBad] = useState(false);
  const data = useRemote<Loaded>(async () => {
    const [groups, options, uses] = await Promise.all([
      ctx.client
        .from('modifier_groups')
        .select('id, name')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort'),
      ctx.client
        .from('modifier_options')
        .select('id, group_id, name')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort'),
      ctx.client
        .from('modifier_option_stock')
        .select('option_id, item_id, quantity, instead_of')
        .eq('store_id', storeId),
    ]);
    if (groups.error || options.error || uses.error) throw new Error('load');
    const opts = (options.data ?? []) as { id: string; group_id: string; name: Name }[];
    return {
      groups: ((groups.data ?? []) as { id: string; name: Name }[])
        .map((g) => ({
          id: g.id,
          name: g.name,
          options: opts.filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name })),
        }))
        .filter((g) => g.options.length > 0),
      uses: parseOptionUse(uses.data),
    };
  }, storeId);
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const itemName = (id: string) => {
    const it = itemOf(id);
    return it ? localizedName(it.name, lang) : '—';
  };

  const save = async () => {
    if (!form) return;
    setBad(false);
    const it = itemOf(form.itemId);
    const q = it ? parseQty(form.qty, it.unit === 'pcs' ? 'pcs' : it.unit) : null;
    if (!it || q === null || q < 1) return setBad(true);
    const { error } = await ctx.client.from('modifier_option_stock').insert({
      org_id: ctx.orgId,
      store_id: storeId,
      option_id: form.optionId,
      item_id: it.id,
      quantity: q,
      instead_of: form.insteadOf || null,
    });
    if (error) return fail(error.code);
    setForm(null);
    data.reload();
    done();
  };
  const remove = async (u: OptionUse) => {
    const { error } = await ctx.client
      .from('modifier_option_stock')
      .delete()
      .eq('option_id', u.optionId)
      .eq('item_id', u.itemId);
    if (error) return fail(error.code);
    data.reload();
    done();
  };

  return (
    <>
      <p className="muted">{t.stockOptIntro}</p>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.data && data.data.groups.length === 0 ? (
        <p className="muted">{t.stockOptEmpty}</p>
      ) : null}
      {(data.data?.groups ?? []).map((g) => (
        <section key={g.id} className="card admin-card">
          <h2>{localizedName(g.name, lang)}</h2>
          <ul className="member-list">
            {g.options.map((o) => {
              const links = (data.data?.uses ?? []).filter((u) => u.optionId === o.id);
              return (
                <li key={o.id} className="member-row">
                  <div className="member-head">
                    <strong>{localizedName(o.name, lang)}</strong>
                    {links.length === 0 ? <span className="muted">{t.stockOptNoLinks}</span> : null}
                  </div>
                  <ul className="muted">
                    {links.map((u) => {
                      const it = itemOf(u.itemId);
                      const q = splitQty(u.quantity, it?.unit ?? 'pcs');
                      return (
                        <li key={u.itemId}>
                          {fmt(t.stockOptUses, {
                            name: itemName(u.itemId),
                            qty: q.value,
                            unit: tx(t, `stockU_${q.unit}`),
                          })}
                          {u.insteadOf
                            ? ` · ${fmt(t.stockOptInstead, { name: itemName(u.insteadOf) })}`
                            : ''}{' '}
                          {canEdit ? (
                            <AsyncButton variant="secondary" onClick={() => remove(u)}>
                              {t.stockOptRemove}
                            </AsyncButton>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {canEdit ? (
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={items.length === 0}
                        onClick={() => {
                          setBad(false);
                          setForm({
                            optionId: o.id,
                            itemId: items[0]?.id ?? '',
                            qty: '',
                            insteadOf: '',
                          });
                        }}
                      >
                        {t.stockOptAdd}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {form ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.stockOptAdd}
        >
          <div className="form-row">
            <label className="label" htmlFor="opt-item">
              {t.stockOptItem}
            </label>
            <select
              id="opt-item"
              className="field"
              value={form.itemId}
              onChange={(e) => setForm({ ...form, itemId: e.target.value })}
            >
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {localizedName(i.name, lang)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="opt-qty">
              {fmt(t.stockOptQty, { unit: tx(t, `stockU_${itemOf(form.itemId)?.unit ?? 'pcs'}`) })}
            </label>
            <input
              id="opt-qty"
              className="field tabular"
              inputMode="numeric"
              value={form.qty}
              onChange={(e) => setForm({ ...form, qty: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="opt-instead">
              {t.stockOptInsteadOf}
            </label>
            <select
              id="opt-instead"
              className="field"
              value={form.insteadOf}
              onChange={(e) => setForm({ ...form, insteadOf: e.target.value })}
            >
              <option value="">{t.stockOptNone}</option>
              {items
                .filter((i) => i.id !== form.itemId)
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {localizedName(i.name, lang)}
                  </option>
                ))}
            </select>
          </div>
          {bad ? <Notice kind="error">{t.stockInvalid}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={save}>
              {t.stockOptSave}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}
