import { useState } from 'react';
import { bangkokDate, formatTHB, guestName, parsePromotions } from '@bestie/core';
import type { LocalizedText, Promotion } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Form = {
  id: string | null;
  name: string;
  code: string;
  kind: 'percent' | 'amount';
  value: string;
  scope: 'bill' | 'item';
  itemIds: string[];
  minSubtotal: string;
  weekdays: number[];
  fromTime: string;
  toTime: string;
  startsOn: string;
  endsOn: string;
  channels: string[];
  margin: string;
  active: boolean;
};
const CHANNELS = ['dine-in', 'takeaway', 'delivery', 'qr'] as const;
const EMPTY: Form = {
  id: null,
  name: '',
  code: '',
  kind: 'percent',
  value: '10',
  scope: 'bill',
  itemIds: [],
  minSubtotal: '',
  weekdays: [],
  fromTime: '',
  toTime: '',
  startsOn: '',
  endsOn: '',
  channels: [],
  margin: '0',
  active: true,
};
const toggle = <T,>(a: T[], v: T): T[] => (a.includes(v) ? a.filter((x) => x !== v) : [...a, v]);
const addDays = (d: string, n: number): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** Promotions of the shop (data, `menu.edit`); the order screen applies them. Saving warns when a discount would sell a dish below its cost. */
export function PromotionsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info' | 'success'; text: string } | null>(null);
  const [guard, setGuard] = useState<string[] | null>(null);
  const wd = [t.prWday1, t.prWday2, t.prWday3, t.prWday4, t.prWday5, t.prWday6, t.prWday7];

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const to = bangkokDate(Date.now());
    const [promos, items, rep] = await Promise.all([
      ctx.client.from('promotions').select('*').eq('store_id', storeId).order('created_at'),
      ctx.client
        .from('menu_items')
        .select('id, name')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort'),
      ctx.client.rpc('promotions_report', { p: { store_id: storeId, from: addDays(to, -29), to } }),
    ]);
    if (promos.error || items.error) throw new Error('load');
    return {
      promos: parsePromotions(promos.data),
      items: (items.data ?? []) as { id: string; name: LocalizedText }[],
      report: (Array.isArray(rep.data) ? rep.data : []) as {
        promo_id: string;
        name: string;
        bills: number;
        given: number;
      }[],
    };
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;

  const edit = (p: Promotion) => {
    setGuard(null);
    setMsg(null);
    setForm({
      id: p.id,
      name: p.name,
      code: p.code ?? '',
      kind: p.kind,
      value: p.kind === 'percent' ? String(p.value / 100) : String(p.value / 100),
      scope: p.scope,
      itemIds: p.itemIds,
      minSubtotal: p.minSubtotal ? String(p.minSubtotal / 100) : '',
      weekdays: p.weekdays,
      fromTime: p.fromTime ?? '',
      toTime: p.toTime ?? '',
      startsOn: p.startsOn ?? '',
      endsOn: p.endsOn ?? '',
      channels: p.channels,
      margin: String(p.minMarginBps / 100),
      active: p.active,
    });
  };
  const save = async (force = false) => {
    if (!form || !storeId) return;
    setMsg(null);
    const v = Number(form.value.replace(',', '.'));
    if (!form.name.trim() || !Number.isFinite(v) || v <= 0)
      return setMsg({ kind: 'error', text: t.prInvalid });
    const r = await ctx.client.rpc('save_promotion', {
      p: {
        store_id: storeId,
        id: form.id,
        name: form.name.trim(),
        code: form.code.trim() || null,
        kind: form.kind,
        value: Math.round(v * 100),
        scope: form.scope,
        item_ids: form.scope === 'item' ? form.itemIds : [],
        min_subtotal: Math.round((Number(form.minSubtotal) || 0) * 100),
        channels: form.channels,
        weekdays: form.weekdays,
        from_time: form.fromTime || null,
        to_time: form.toTime || null,
        starts_on: form.startsOn || null,
        ends_on: form.endsOn || null,
        min_margin_bps: Math.round((Number(form.margin) || 0) * 100),
        active: form.active,
        force,
      },
    });
    if (r.error)
      return setMsg({
        kind: 'error',
        text:
          r.error.code === '23505'
            ? t.prCodeUsed
            : r.error.code === '23514' || r.error.code === '22023'
              ? t.prInvalid
              : r.error.code === '42501'
                ? t.err_forbidden
                : t.err_save_failed,
      });
    const res = (r.data ?? {}) as { active?: boolean; below_margin?: string[] };
    if ((res.below_margin?.length ?? 0) > 0 && res.active === false)
      setGuard(res.below_margin ?? []);
    else {
      setGuard(null);
      setForm(null);
      setMsg({ kind: 'success', text: t.prSaved });
    }
    reload();
  };
  const remove = async (id: string) => {
    const r = await ctx.client.rpc('delete_promotion', { p_id: id });
    if (r.error) return setMsg({ kind: 'error', text: t.err_save_failed });
    reload();
  };
  const field = (id: string, label: string, el: React.ReactNode) => (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {el}
    </div>
  );
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="admin-page">
      <h1>{t.prTitle}</h1>
      <Notice kind="info">{t.prIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d && d.promos.length === 0 ? <p className="muted">{t.prNone}</p> : null}
      <ul className="member-list">
        {(d?.promos ?? [])
          .filter((p) => p.active || true)
          .map((p) => (
            <li key={p.id} className="card admin-card">
              <strong>{p.name}</strong> {p.code ? <span className="badge">{p.code}</span> : null}{' '}
              {!p.active ? <span className="badge">{t.prOff}</span> : null}
              <p className="muted">
                {p.kind === 'percent' ? `${p.value / 100}%` : money(p.value)} ·{' '}
                {p.weekdays.length > 0 ? p.weekdays.map((x) => wd[x - 1]).join(' ') : ''}{' '}
                {p.fromTime ? `${p.fromTime}–${p.toTime}` : ''}
              </p>
              {canEdit ? (
                <div className="actions">
                  <AsyncButton variant="secondary" onClick={async () => edit(p)}>
                    {t.prEdit}
                  </AsyncButton>
                  <AsyncButton variant="secondary" onClick={() => remove(p.id)}>
                    {t.prDelete}
                  </AsyncButton>
                </div>
              ) : null}
            </li>
          ))}
      </ul>
      {canEdit && !form ? (
        <div className="actions">
          <AsyncButton
            variant="secondary"
            onClick={async () => {
              setGuard(null);
              setForm({ ...EMPTY });
            }}
          >
            {t.prNew}
          </AsyncButton>
        </div>
      ) : null}
      {canEdit && form ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.prNew}
        >
          <h2>{t.prNew}</h2>
          {field(
            'pr-name',
            t.prName,
            <input
              id="pr-name"
              className="field"
              maxLength={60}
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />,
          )}
          {field(
            'pr-code',
            t.prCode,
            <input
              id="pr-code"
              className="field"
              maxLength={20}
              value={form.code}
              onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            />,
          )}
          {field(
            'pr-kind',
            t.prKind,
            <select
              id="pr-kind"
              className="field"
              value={form.kind}
              onChange={(e) => set({ kind: e.target.value as Form['kind'] })}
            >
              <option value="percent">{t.prPercent}</option>
              <option value="amount">{t.prAmount}</option>
            </select>,
          )}
          {field(
            'pr-value',
            t.prValue,
            <input
              id="pr-value"
              className="field"
              inputMode="decimal"
              value={form.value}
              onChange={(e) => set({ value: e.target.value })}
            />,
          )}
          {field(
            'pr-scope',
            t.prScope,
            <select
              id="pr-scope"
              className="field"
              value={form.scope}
              onChange={(e) => set({ scope: e.target.value as Form['scope'] })}
            >
              <option value="bill">{t.prScopeBill}</option>
              <option value="item">{t.prScopeItem}</option>
            </select>,
          )}
          {form.scope === 'item' ? (
            <fieldset>
              <legend>{t.prItems}</legend>
              {(d?.items ?? []).map((i) => (
                <label key={i.id} className="check">
                  <input
                    type="checkbox"
                    checked={form.itemIds.includes(i.id)}
                    onChange={() => set({ itemIds: toggle(form.itemIds, i.id) })}
                  />{' '}
                  {guestName(i.name, lang)}
                </label>
              ))}
            </fieldset>
          ) : null}
          {field(
            'pr-min',
            t.prMin,
            <input
              id="pr-min"
              className="field"
              inputMode="decimal"
              value={form.minSubtotal}
              onChange={(e) => set({ minSubtotal: e.target.value })}
            />,
          )}
          <fieldset>
            <legend>{t.prDays}</legend>
            {wd.map((w, i) => (
              <label key={w} className="check">
                <input
                  type="checkbox"
                  checked={form.weekdays.includes(i + 1)}
                  onChange={() => set({ weekdays: toggle(form.weekdays, i + 1) })}
                />{' '}
                {w}
              </label>
            ))}
          </fieldset>
          {field(
            'pr-from',
            t.prFrom,
            <input
              id="pr-from"
              className="field"
              type="time"
              value={form.fromTime}
              onChange={(e) => set({ fromTime: e.target.value })}
            />,
          )}
          {field(
            'pr-to',
            t.prTo,
            <input
              id="pr-to"
              className="field"
              type="time"
              value={form.toTime}
              onChange={(e) => set({ toTime: e.target.value })}
            />,
          )}
          {field(
            'pr-starts',
            t.prStarts,
            <input
              id="pr-starts"
              className="field"
              type="date"
              value={form.startsOn}
              onChange={(e) => set({ startsOn: e.target.value })}
            />,
          )}
          {field(
            'pr-ends',
            t.prEnds,
            <input
              id="pr-ends"
              className="field"
              type="date"
              value={form.endsOn}
              onChange={(e) => set({ endsOn: e.target.value })}
            />,
          )}
          <fieldset>
            <legend>{t.prChannels}</legend>
            {CHANNELS.map((c) => (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={form.channels.includes(c)}
                  onChange={() => set({ channels: toggle(form.channels, c) })}
                />{' '}
                {c}
              </label>
            ))}
          </fieldset>
          {field(
            'pr-margin',
            t.prMargin,
            <input
              id="pr-margin"
              className="field"
              inputMode="decimal"
              value={form.margin}
              onChange={(e) => set({ margin: e.target.value })}
            />,
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set({ active: e.target.checked })}
            />{' '}
            {t.prActive}
          </label>
          {guard ? (
            <Notice kind="error">{fmt(t.prOffByGuard, { names: guard.join(', ') })}</Notice>
          ) : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={() => save(false)}>
              {t.prSave}
            </AsyncButton>
            {guard && ctx.isOwner ? (
              <AsyncButton variant="secondary" onClick={() => save(true)}>
                {t.prForce}
              </AsyncButton>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : null}
      <section className="card admin-card" aria-label={t.prReport}>
        <h2>{t.prReport}</h2>
        {(d?.report.length ?? 0) === 0 ? <p className="muted">{t.prReportNone}</p> : null}
        <ul>
          {(d?.report ?? []).map((r) => (
            <li key={r.promo_id}>
              <strong>{r.name}</strong>:{' '}
              {fmt(t.prGiven, { money: money(Number(r.given)), bills: r.bills })}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
