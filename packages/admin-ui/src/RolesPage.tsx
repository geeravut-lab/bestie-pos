import { useState } from 'react';
import { PERMISSIONS } from '@bestie/core';
import type { Permission } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type RoleRow = { id: string; name: string; built_in: string | null; permissions: string[] };
type Draft = { id: string | null; name: string; permissions: Set<string> };
const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/**
 * Roles: the built-in ones (read only) and the shop's own. Whoever edits can only hand out permissions they hold themselves
 * (the owner any); the database refuses anything else, so this screen only hides what would be refused.
 */
export function RolesPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canManage = ctx.isOwner || ctx.permissions.includes('staff.manage');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const list = useRemote(async () => {
    const { data, error: e } = await ctx.client
      .from('roles')
      .select('id, name, built_in, permissions')
      .eq('org_id', ctx.orgId)
      .order('created_at');
    if (e) throw new Error(e.code ?? 'query');
    return ((data ?? []) as RoleRow[]).map((r) => ({
      ...r,
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
    }));
  }, ctx.orgId);

  if (!canManage)
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_forbidden', t)}</Notice>
      </div>
    );
  // what this person may hand out: everything for the owner, otherwise what they hold
  const mayGive = (p: Permission) => ctx.isOwner || ctx.permissions.includes(p);
  const fail = (code?: string) =>
    setError(
      code === '42501' ? 'err_forbidden' : code === '23503' ? 'err_role_in_use' : 'err_save_failed',
    );

  const save = async () => {
    if (!draft) return;
    setError(null);
    setSaved(false);
    const values = { name: draft.name.trim(), permissions: [...draft.permissions] };
    const r = draft.id
      ? await ctx.client.from('roles').update(values).eq('id', draft.id).select('id')
      : await ctx.client.from('roles').insert({ org_id: ctx.orgId, ...values });
    if (r.error) return fail(r.error.code);
    if (draft.id && (r.data as unknown[] | null)?.length !== 1) return fail();
    setDraft(null);
    setSaved(true);
    list.reload();
  };
  const remove = async (id: string) => {
    setError(null);
    const { error: e } = await ctx.client.from('roles').delete().eq('id', id);
    setConfirm(null);
    if (e) return fail(e.code);
    list.reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.rolesTitle}</h1>
      <Notice kind="info">{t.rolesIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.rolesSaved}</Notice> : null}
      {list.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      <ul className="member-list">
        {(list.data ?? []).map((r) => (
          <li key={r.id} className="member-row">
            <div className="member-head">
              <strong>{r.name}</strong>
              {r.built_in ? <span className="badge">{t.rolesBuiltIn}</span> : null}
            </div>
            <p className="muted">
              {r.built_in === 'owner'
                ? t.rolesOwnerAll
                : r.permissions.map((p) => tx(t, `perm_${p.replace('.', '_')}`)).join(' · ') || '—'}
            </p>
            {!r.built_in ? (
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setDraft({ id: r.id, name: r.name, permissions: new Set(r.permissions) })
                  }
                >
                  {t.rolesEdit}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirm(r.id)}
                >
                  {t.rolesDelete}
                </button>
              </div>
            ) : null}
            {confirm === r.id ? (
              <div className="confirm-box" role="alertdialog" aria-label={r.name}>
                <p>{fmt(t.rolesDeleteConfirm, { name: r.name })}</p>
                <div className="actions">
                  <AsyncButton variant="danger" onClick={() => remove(r.id)}>
                    {t.rolesDelete}
                  </AsyncButton>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setConfirm(null)}
                  >
                    {t.menuCancel}
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {draft ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.rolesAdd}
        >
          <div className="form-row">
            <label className="label" htmlFor="role-name">
              {t.rolesName}
            </label>
            <input
              id="role-name"
              className="field"
              maxLength={60}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <fieldset className="form-row">
            <legend className="label">{t.rolesPermissions}</legend>
            {PERMISSIONS.map((p) => (
              <label key={p} className="check-row">
                <input
                  type="checkbox"
                  disabled={!mayGive(p) && !draft.permissions.has(p)}
                  checked={draft.permissions.has(p)}
                  onChange={(e) => {
                    const next = new Set(draft.permissions);
                    if (e.target.checked) next.add(p);
                    else next.delete(p);
                    setDraft({ ...draft, permissions: next });
                  }}
                />
                <span>{tx(t, `perm_${p.replace('.', '_')}`)}</span>
              </label>
            ))}
            {!ctx.isOwner ? <p className="muted">{t.rolesOnlyYours}</p> : null}
          </fieldset>
          <div className="actions">
            <AsyncButton type="submit" disabled={draft.name.trim() === ''} onClick={save}>
              {t.rolesSave}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setDraft({ id: null, name: '', permissions: new Set() })}
          >
            {t.rolesAdd}
          </button>
        </div>
      )}
    </div>
  );
}
