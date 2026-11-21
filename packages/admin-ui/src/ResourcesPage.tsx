import { useState } from 'react';
import { PLACE_KINDS, PROVIDER_KINDS, parseResources } from '@bestie/core';
import type { Resource, ResourceKind } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { BookingLinkPanel } from './BookingLinkPanel';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

/** Stylists / therapists and rooms / beds / chairs — what a booking is made against. */
export function ResourcesPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const placesOn = ctx.isModuleOn ? ctx.isModuleOn('resources') : true;
  const [form, setForm] = useState<{ name: string; kind: ResourceKind } | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [bad, setBad] = useState(false);
  const people = useRemote<{ id: string; name: string }[]>(async () => {
    const r = await ctx.client
      .from('staff')
      .select('id, display_name')
      .eq('org_id', ctx.orgId)
      .eq('active', true)
      .order('display_name');
    if (r.error) return [];
    return ((r.data ?? []) as { id: string; display_name: string }[]).map((x) => ({
      id: x.id,
      name: x.display_name,
    }));
  }, ctx.orgId);
  const data = useRemote<Resource[]>(async () => {
    if (!storeId) throw new Error('shop');
    const r = await ctx.client
      .from('resources')
      .select('id, name, kind, active, sort, staff_id')
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .order('sort');
    if (r.error) throw new Error('load');
    return parseResources(r.data);
  }, storeId ?? '');
  const kinds = [...PROVIDER_KINDS, ...(placesOn ? PLACE_KINDS : [])] as ResourceKind[];

  const save = async () => {
    if (!form || !storeId) return;
    setError(null);
    setBad(false);
    const name = form.name.trim();
    if (!name || name.length > 60) return setBad(true);
    const { error: err } = await ctx.client.from('resources').insert({
      org_id: ctx.orgId,
      store_id: storeId,
      name,
      kind: form.kind,
      sort: (data.data?.length ?? 0) + 1,
    });
    if (err) {
      if (err.code === '23505') return setBad(true);
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setForm(null);
    data.reload();
  };
  const link = async (r: Resource, staffId: string) => {
    setError(null);
    const { error: err } = await ctx.client
      .from('resources')
      .update({ staff_id: staffId || null })
      .eq('id', r.id)
      .select('id');
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    data.reload();
  };
  const toggle = async (r: Resource) => {
    setError(null);
    const { error: err } = await ctx.client
      .from('resources')
      .update({ active: !r.active })
      .eq('id', r.id)
      .select('id');
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    data.reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.resTitle}</h1>
      <Notice kind="info">{t.resIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton variant="secondary" onClick={() => ctx.navigate('/days-off')}>
          {t.daysOffLink}
        </AsyncButton>
        <AsyncButton variant="secondary" onClick={() => ctx.navigate('/hair-styles')}>
          {t.hsLink}
        </AsyncButton>
        <AsyncButton variant="secondary" onClick={() => ctx.navigate('/group-booking')}>
          {t.groupLink}
        </AsyncButton>
      </div>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {data.data && data.data.length === 0 ? <p className="muted">{t.resEmpty}</p> : null}
      <ul className="member-list">
        {(data.data ?? []).map((r) => (
          <li key={r.id} className="member-row">
            <div className="member-head">
              <strong>{r.name}</strong>
              <span className="badge">{tx(t, `resKind_${r.kind}`)}</span>
              {!r.active ? <span className="muted">{t.resInactive}</span> : null}
            </div>
            {canEdit && (r.kind === 'stylist' || r.kind === 'therapist') ? (
              <div className="form-row">
                <label className="label" htmlFor={`res-person-${r.id}`}>
                  {t.resPerson}
                </label>
                <select
                  id={`res-person-${r.id}`}
                  className="field"
                  value={r.staffId ?? ''}
                  onChange={(e) => void link(r, e.target.value)}
                >
                  <option value="">{t.resNoPerson}</option>
                  {(people.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {canEdit ? (
              <div className="actions">
                <AsyncButton variant="secondary" onClick={() => toggle(r)}>
                  {r.active ? t.resDeactivate : t.resActivate}
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
          aria-label={t.resAdd}
        >
          <div className="form-row">
            <label className="label" htmlFor="res-name">
              {t.resName}
            </label>
            <input
              id="res-name"
              className="field"
              maxLength={60}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="res-kind">
              {t.resKind}
            </label>
            <select
              id="res-kind"
              className="field"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as ResourceKind })}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {tx(t, `resKind_${k}`)}
                </option>
              ))}
            </select>
          </div>
          {bad ? <Notice kind="error">{t.resInvalid}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={save}>
              {t.resSave}
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
            onClick={() => setForm({ name: '', kind: 'stylist' })}
          >
            {t.resAdd}
          </button>
        </div>
      ) : null}
      {storeId && ctx.isModuleOn?.('booking.online') ? (
        <BookingLinkPanel ctx={ctx} storeId={storeId} />
      ) : null}
    </div>
  );
}
