import { useState } from 'react';
import {
  bangkokDate,
  formatTHB,
  guestName,
  parsePriceInput,
  parseStampPrograms,
  parseStampReport,
} from '@bestie/core';
import type { LocalizedText } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Form = {
  kind: 'stamps' | 'pass';
  th: string;
  en: string;
  reward: string;
  needed: string;
  minSpend: string;
  price: string;
  days: string;
};
const EMPTY: Form = {
  kind: 'stamps',
  th: '',
  en: '',
  reward: '',
  needed: '5',
  minSpend: '0',
  price: '300',
  days: '30',
};
const addDays = (d: string, n: number): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** Stamp cards and day passes of the shop (`menu.edit` to change, `report.view` for the numbers). */
export function StampsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canReport = ctx.isOwner || ctx.permissions.includes('report.view');
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const to = bangkokDate(Date.now());
    const [progs, items, rep] = await Promise.all([
      ctx.client
        .from('stamp_programs')
        .select('*')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('created_at'),
      ctx.client
        .from('menu_items')
        .select('id, name')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort'),
      canReport
        ? ctx.client.rpc('stamps_report', { p: { store_id: storeId, from: addDays(to, -29), to } })
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (progs.error || items.error) throw new Error('load');
    return {
      programs: parseStampPrograms(progs.data),
      items: (items.data ?? []) as { id: string; name: LocalizedText }[],
      report: rep.error || !rep.data ? null : parseStampReport(rep.data),
    };
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;
  const itemName = (id: string) => {
    const it = d?.items.find((x) => x.id === id);
    return it ? guestName(it.name, lang) : '—';
  };
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const save = async () => {
    if (!form || !storeId) return;
    setMsg(null);
    const needed = Number(form.needed);
    const price = parsePriceInput(form.price);
    const days = Number(form.days);
    const minSpend = parsePriceInput(form.minSpend || '0');
    const bad =
      !form.th.trim() ||
      !form.reward ||
      minSpend === null ||
      (form.kind === 'stamps'
        ? !Number.isInteger(needed) || needed < 2 || needed > 50
        : price === null || price < 1 || !Number.isInteger(days) || days < 1 || days > 366);
    if (bad) return setMsg({ kind: 'error', text: t.stpInvalid });
    const r = await ctx.client.rpc('save_stamp_program', {
      p: {
        store_id: storeId,
        kind: form.kind,
        name: { th: form.th.trim(), ...(form.en.trim() ? { en: form.en.trim() } : {}) },
        reward_item_id: form.reward,
        ...(form.kind === 'stamps'
          ? { stamps_needed: needed, min_spend: minSpend }
          : { pass_price: price, pass_days: days }),
        active: true,
      },
    });
    if (r.error)
      return setMsg({
        kind: 'error',
        text: r.error.code === '42501' ? t.err_forbidden : t.stpInvalid,
      });
    setForm(null);
    setMsg({ kind: 'success', text: t.stpSaved });
    reload();
  };
  const remove = async (id: string) => {
    const r = await ctx.client.rpc('delete_stamp_program', { p_id: id });
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

  return (
    <div className="admin-page">
      <h1>{t.stpTitle}</h1>
      <Notice kind="info">{t.stpIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d?.report ? (
        <section className="card admin-card" aria-label={t.stpReportTitle}>
          <h2>{t.stpReportTitle}</h2>
          <p>
            {t.stpGiven}: <strong>{d.report.stampsGiven}</strong> · {t.stpUsed}:{' '}
            <strong>{d.report.rewardsUsed}</strong> · {t.stpValue}:{' '}
            <strong>{money(d.report.rewardValue)}</strong> · {t.stpSold}:{' '}
            <strong>{d.report.passesSold}</strong> · {t.stpActivePasses}:{' '}
            <strong>{d.report.passesActive}</strong>
          </p>
        </section>
      ) : null}
      {d && d.programs.length === 0 ? <p className="muted">{t.stpNone}</p> : null}
      <ul className="member-list">
        {(d?.programs ?? []).map((p) => (
          <li key={p.id} className="card admin-card">
            <strong>{guestName(p.name, lang)}</strong>{' '}
            <span className="badge">{p.kind === 'stamps' ? t.stpKindStamps : t.stpKindPass}</span>{' '}
            {!p.active ? <span className="badge">{t.stpOff}</span> : null}
            <p className="muted">
              {p.kind === 'stamps'
                ? fmt(t.stpRule, { n: p.stampsNeeded ?? 0, min: money(p.minSpend) })
                : fmt(t.stpPassRule, {
                    price: money(p.passPrice ?? 0),
                    days: p.passDays ?? 0,
                  })}{' '}
              · {t.stpReward}: {itemName(p.rewardItemId)}
            </p>
            {canEdit ? (
              <AsyncButton variant="secondary" onClick={() => remove(p.id)}>
                {t.stpDelete}
              </AsyncButton>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit && !form ? (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setMsg(null);
            setForm({ ...EMPTY, reward: d?.items[0]?.id ?? '' });
          }}
        >
          {t.stpAdd}
        </button>
      ) : null}
      {form ? (
        <section className="card admin-card" aria-label={t.stpAdd}>
          <h2>{t.stpAdd}</h2>
          {field(
            'stp-kind',
            t.stpAdd,
            <select
              id="stp-kind"
              value={form.kind}
              onChange={(e) => set({ kind: e.target.value === 'pass' ? 'pass' : 'stamps' })}
            >
              <option value="stamps">{t.stpKindStamps}</option>
              <option value="pass">{t.stpKindPass}</option>
            </select>,
          )}
          {field(
            'stp-th',
            t.stpName,
            <input
              id="stp-th"
              value={form.th}
              maxLength={60}
              onChange={(e) => set({ th: e.target.value })}
            />,
          )}
          {field(
            'stp-en',
            t.stpNameEn,
            <input
              id="stp-en"
              value={form.en}
              maxLength={60}
              onChange={(e) => set({ en: e.target.value })}
            />,
          )}
          {field(
            'stp-reward',
            t.stpReward,
            <select
              id="stp-reward"
              value={form.reward}
              onChange={(e) => set({ reward: e.target.value })}
            >
              {(d?.items ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {guestName(i.name, lang)}
                </option>
              ))}
            </select>,
          )}
          {form.kind === 'stamps' ? (
            <>
              {field(
                'stp-needed',
                t.stpNeeded,
                <input
                  id="stp-needed"
                  inputMode="numeric"
                  value={form.needed}
                  onChange={(e) => set({ needed: e.target.value })}
                />,
              )}
              {field(
                'stp-min',
                t.stpMinSpend,
                <input
                  id="stp-min"
                  inputMode="decimal"
                  value={form.minSpend}
                  onChange={(e) => set({ minSpend: e.target.value })}
                />,
              )}
            </>
          ) : (
            <>
              {field(
                'stp-price',
                t.stpPassPrice,
                <input
                  id="stp-price"
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => set({ price: e.target.value })}
                />,
              )}
              {field(
                'stp-days',
                t.stpPassDays,
                <input
                  id="stp-days"
                  inputMode="numeric"
                  value={form.days}
                  onChange={(e) => set({ days: e.target.value })}
                />,
              )}
            </>
          )}
          <div className="actions">
            <AsyncButton onClick={save}>{t.stpSave}</AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
              {t.modulesCancel}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
