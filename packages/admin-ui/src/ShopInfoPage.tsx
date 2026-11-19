import { useState } from 'react';
import { parseInfoCards } from '@bestie/core';
import type { InfoCard } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Row = InfoCard & { sort: number; active: boolean };
type Draft = {
  id: string | null;
  titleTh: string;
  titleEn: string;
  bodyTh: string;
  bodyEn: string;
  sort: string;
  active: boolean;
};
const blank: Draft = {
  id: null,
  titleTh: '',
  titleEn: '',
  bodyTh: '',
  bodyEn: '',
  sort: '100',
  active: true,
};

/** The shop's information cards for guests (wifi, hours, check-out, tips). Needs menu.edit; the guest reads the shop's own words. */
export function ShopInfoPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const list = useRemote(
    async () => {
      if (!storeId) return [] as Row[];
      const { data, error: e } = await ctx.client
        .from('shop_info')
        .select('id, title, body, sort, active')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort');
      if (e) throw new Error(e.code ?? 'query');
      const rows = (data ?? []) as { id: string; sort?: number; active?: boolean }[];
      const cards = parseInfoCards(rows);
      return cards.map((c) => {
        const r = rows.find((x) => x.id === c.id);
        return { ...c, sort: r?.sort ?? 100, active: r?.active !== false };
      });
    },
    `${storeId ?? ''}`,
  );

  if (!canEdit)
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_forbidden', t)}</Notice>
      </div>
    );

  const save = async () => {
    if (!draft || !storeId) return;
    setError(null);
    setSaved(false);
    const en = (v: string) => (v.trim() ? { en: v.trim() } : {});
    const { error: e } = await ctx.client.rpc('save_shop_info', {
      p: {
        id: draft.id,
        store_id: storeId,
        title: { th: draft.titleTh.trim(), ...en(draft.titleEn) },
        body: { th: draft.bodyTh.trim(), ...en(draft.bodyEn) },
        sort: Number.parseInt(draft.sort, 10) || 100,
        active: draft.active,
      },
    });
    if (e) return setError(e.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setDraft(null);
    setSaved(true);
    list.reload();
  };
  const remove = async (id: string) => {
    setError(null);
    const { error: e } = await ctx.client.rpc('delete_shop_info', { p_id: id });
    if (e) return setError(e.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    list.reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.infoTitle}</h1>
      <Notice kind="info">{t.infoIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.infoSaved}</Notice> : null}
      {list.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {list.status === 'ready' && (list.data ?? []).length === 0 ? (
        <p className="muted">{t.infoEmpty}</p>
      ) : null}
      <ul className="member-list">
        {(list.data ?? []).map((c) => (
          <li key={c.id} className="member-row">
            <strong>{c.title.th}</strong>
            {c.active ? null : <span className="badge">{t.infoActive}: ✕</span>}
            <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
              {c.body.th}
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  setDraft({
                    id: c.id,
                    titleTh: c.title.th,
                    titleEn: c.title.en ?? '',
                    bodyTh: c.body.th,
                    bodyEn: c.body.en ?? '',
                    sort: String(c.sort),
                    active: c.active,
                  })
                }
              >
                {t.infoEdit}
              </button>
              <AsyncButton variant="danger" onClick={() => remove(c.id)}>
                {t.infoDelete}
              </AsyncButton>
            </div>
          </li>
        ))}
      </ul>
      {draft ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.infoAdd}
        >
          {(
            [
              ['titleTh', t.infoTitleTh, 80],
              ['titleEn', t.infoTitleEn, 80],
            ] as const
          ).map(([k, label, max]) => (
            <div className="form-row" key={k}>
              <label className="label" htmlFor={`info-${k}`}>
                {label}
              </label>
              <input
                id={`info-${k}`}
                className="field"
                maxLength={max}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            </div>
          ))}
          {(
            [
              ['bodyTh', t.infoBodyTh],
              ['bodyEn', t.infoBodyEn],
            ] as const
          ).map(([k, label]) => (
            <div className="form-row" key={k}>
              <label className="label" htmlFor={`info-${k}`}>
                {label}
              </label>
              <textarea
                id={`info-${k}`}
                className="field"
                rows={4}
                maxLength={1000}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            </div>
          ))}
          <div className="form-row">
            <label className="label" htmlFor="info-sort">
              {t.infoSort}
            </label>
            <input
              id="info-sort"
              className="field tabular"
              inputMode="numeric"
              value={draft.sort}
              onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
            />
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            />
            <span>{t.infoActive}</span>
          </label>
          <div className="actions">
            <AsyncButton
              type="submit"
              disabled={draft.titleTh.trim() === '' || draft.bodyTh.trim() === ''}
              onClick={save}
            >
              {t.infoSave}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setDraft({ ...blank })}>
            {t.infoAdd}
          </button>
        </div>
      )}
    </div>
  );
}
