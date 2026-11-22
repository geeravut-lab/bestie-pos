import { useState } from 'react';
import { MARKETING_STOP_FOOTER, parseCampaigns } from '@bestie/core';
import type { Campaign, CampaignKind } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Form = {
  id: string | null;
  name: string;
  kind: CampaignKind;
  idle: string;
  th: string;
  en: string;
  active: boolean;
};
const EMPTY: Form = {
  id: null,
  name: '',
  kind: 'winback',
  idle: '30',
  th: '',
  en: '',
  active: false,
};

/** LINE promotions for members who agreed (module `marketing`, `menu.edit` to change). The footer with STOP is added to every message by the server. */
export function MarketingPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);
  const kindLabel = (k: CampaignKind) =>
    k === 'rebook' ? t.mktK_rebook : k === 'welcome' ? t.mktK_welcome : t.mktK_winback;

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const r = await ctx.client
      .from('marketing_campaigns')
      .select('*')
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .order('created_at');
    if (r.error) throw new Error('load');
    return parseCampaigns(r.data);
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);

  const edit = (c: Campaign) =>
    setForm({
      id: c.id,
      name: c.name,
      kind: c.kind,
      idle: String(c.idleDays),
      th: c.message.th,
      en: c.message.en ?? '',
      active: c.active,
    });
  const save = async () => {
    if (!form || !storeId) return;
    setMsg(null);
    const idle = Number(form.idle);
    if (!form.name.trim() || !form.th.trim() || !Number.isInteger(idle) || idle < 7 || idle > 365)
      return setMsg({ kind: 'error', text: t.mktInvalid });
    const r = await ctx.client.rpc('save_marketing_campaign', {
      p: {
        id: form.id,
        store_id: storeId,
        name: form.name.trim(),
        kind: form.kind,
        idle_days: idle,
        message: { th: form.th.trim(), ...(form.en.trim() ? { en: form.en.trim() } : {}) },
        active: form.active,
      },
    });
    if (r.error)
      return setMsg({
        kind: 'error',
        text:
          r.error.code === '0A000'
            ? t.mktOff
            : r.error.code === '42501'
              ? t.err_forbidden
              : t.mktInvalid,
      });
    setForm(null);
    setMsg({ kind: 'success', text: t.mktSaved });
    reload();
  };
  const preview = async (c: Campaign) => {
    setMsg(null);
    const r = await ctx.client.rpc('marketing_preview', { p_campaign: c.id });
    const o = (r.data ?? {}) as { eligible?: number; linked?: number };
    if (r.error) return setMsg({ kind: 'error', text: t.err_load_failed });
    setMsg({ kind: 'info', text: fmt(t.mktEligible, { n: o.eligible ?? 0, m: o.linked ?? 0 }) });
  };
  const remove = async (id: string) => {
    const r = await ctx.client.rpc('delete_marketing_campaign', { p_id: id });
    if (r.error) return setMsg({ kind: 'error', text: t.err_save_failed });
    reload();
  };
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const field = (id: string, label: string, el: React.ReactNode) => (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {el}
    </div>
  );
  const list = data.data ?? [];

  return (
    <div className="admin-page">
      <h1>{t.mktTitle}</h1>
      <Notice kind="info">{t.mktIntro}</Notice>
      <p className="muted">{t.mktHow}</p>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {data.status === 'ready' && list.length === 0 ? <p className="muted">{t.mktNone}</p> : null}
      <ul className="member-list">
        {list.map((c) => (
          <li key={c.id} className="card admin-card">
            <strong>{c.name}</strong> <span className="badge">{kindLabel(c.kind)}</span>{' '}
            {!c.active ? <span className="badge">{t.mktOff}</span> : null}
            <p className="muted">{c.message.th}</p>
            <div className="actions">
              <AsyncButton variant="secondary" onClick={() => preview(c)}>
                {t.mktPreview}
              </AsyncButton>
              {canEdit ? (
                <>
                  <button type="button" className="btn btn-secondary" onClick={() => edit(c)}>
                    {t.mktEdit}
                  </button>
                  <AsyncButton variant="secondary" onClick={() => remove(c.id)}>
                    {t.mktDelete}
                  </AsyncButton>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {canEdit && !form ? (
        <button type="button" className="btn btn-primary" onClick={() => setForm(EMPTY)}>
          {t.mktAdd}
        </button>
      ) : null}
      {form ? (
        <section className="card admin-card" aria-label={t.mktAdd}>
          <h2>{t.mktAdd}</h2>
          {field(
            'mkt-name',
            t.mktName,
            <input
              id="mkt-name"
              value={form.name}
              maxLength={80}
              onChange={(e) => set({ name: e.target.value })}
            />,
          )}
          {field(
            'mkt-kind',
            t.mktKind,
            <select
              id="mkt-kind"
              value={form.kind}
              onChange={(e) =>
                set({
                  kind:
                    e.target.value === 'rebook'
                      ? 'rebook'
                      : e.target.value === 'welcome'
                        ? 'welcome'
                        : 'winback',
                })
              }
            >
              <option value="winback">{t.mktK_winback}</option>
              <option value="rebook">{t.mktK_rebook}</option>
              <option value="welcome">{t.mktK_welcome}</option>
            </select>,
          )}
          {form.kind !== 'welcome'
            ? field(
                'mkt-idle',
                t.mktIdle,
                <input
                  id="mkt-idle"
                  inputMode="numeric"
                  value={form.idle}
                  onChange={(e) => set({ idle: e.target.value })}
                />,
              )
            : null}
          {field(
            'mkt-th',
            t.mktMsgTh,
            <textarea
              id="mkt-th"
              rows={3}
              maxLength={400}
              value={form.th}
              onChange={(e) => set({ th: e.target.value })}
            />,
          )}
          {field(
            'mkt-en',
            t.mktMsgEn,
            <textarea
              id="mkt-en"
              rows={3}
              maxLength={400}
              value={form.en}
              onChange={(e) => set({ en: e.target.value })}
            />,
          )}
          <p className="muted">{MARKETING_STOP_FOOTER}</p>
          <label className="check">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set({ active: e.target.checked })}
            />{' '}
            {t.mktActive}
          </label>
          <div className="actions">
            <AsyncButton onClick={save}>{t.mktSave}</AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
              {t.modulesCancel}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
