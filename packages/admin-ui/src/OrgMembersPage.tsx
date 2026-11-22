import { useState } from 'react';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Shop = { id: string; name: string };
type Org = { id: string; name: string; staff: number; empty: boolean; stores: Shop[] };
type Membership = { orgName: string; role: string; storeName: string | null; active: boolean };
type Person = { userId: string; email: string; confirmed: boolean; memberships: Membership[] };

const ROLES = ['owner', 'manager', 'cashier', 'waiter', 'kitchen'] as const;
type RoleKey = (typeof ROLES)[number];

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const str = (x: unknown, fallback = ''): string => (typeof x === 'string' ? x : fallback);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/**
 * Move a person into an existing business (platform administrator only). A business name is not a key, so somebody who signs up and "creates a shop"
 * gets a duplicate business; the proper way in is an invite code, and this page repairs the cases where that went wrong. The server function checks
 * everything (confirmed e-mail, real business / role / shop, nobody left without an owner), deletes the accidental business when it is empty, and logs it.
 */
export function OrgMembersPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [person, setPerson] = useState<Person | null>(null);
  const [orgId, setOrgId] = useState('');
  const [role, setRole] = useState<RoleKey>('manager');
  const [storeId, setStoreId] = useState('');
  const [leave, setLeave] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; lines: string[] } | null>(null);

  const orgs = useRemote(async (): Promise<Org[] | null> => {
    if (!ctx.isPlatformAdmin) return null;
    const r = await ctx.client.rpc('platform_orgs_overview');
    if (r.error) throw new Error('load');
    return list(obj(r.data).orgs).map((x) => {
      const o = obj(x);
      return {
        id: str(o.id),
        name: str(o.name, '—'),
        staff: typeof o.staff_count === 'number' ? o.staff_count : 0,
        empty: o.empty === true,
        stores: list(o.stores).map((s) => ({ id: str(obj(s).id), name: str(obj(s).name, '—') })),
      };
    });
  }, `${ctx.isPlatformAdmin}`);
  const { reload } = orgs;
  if (!ctx.isPlatformAdmin)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.brandAdminOnly}</Notice>
      </div>
    );

  const roleLabel: Record<RoleKey, string> = {
    owner: t.omRoleOwner,
    manager: t.omRoleManager,
    cashier: t.omRoleCashier,
    waiter: t.omRoleWaiter,
    kitchen: t.omRoleKitchen,
  };
  const nameOfRole = (key: string): string =>
    (ROLES as readonly string[]).includes(key) ? roleLabel[key as RoleKey] : key;
  const errText = (code: string | undefined): string =>
    code === 'P0002'
      ? t.omErrNotFound
      : code === '55000'
        ? t.omErrUnconfirmed
        : code === '22023'
          ? t.omErrInvalid
          : t.omErr;

  const orgList = orgs.data ?? [];
  const org = orgList.find((o) => o.id === orgId) ?? null;

  const find = async () => {
    setMsg(null);
    setConfirming(false);
    const r = await ctx.client.rpc('platform_member_lookup', { p_email: email.trim() });
    if (r.error) {
      setPerson(null);
      return setMsg({ kind: 'error', lines: [errText(r.error.code)] });
    }
    const o = obj(r.data);
    setPerson({
      userId: str(o.user_id),
      email: str(o.email, email.trim()),
      confirmed: o.confirmed === true,
      memberships: list(o.memberships).map((x) => {
        const m = obj(x);
        return {
          orgName: str(m.org_name, '—'),
          role: str(m.role),
          storeName: typeof m.store_name === 'string' ? m.store_name : null,
          active: m.active !== false,
        };
      }),
    });
  };

  const move = async () => {
    if (!person || !org) return;
    setMsg(null);
    const r = await ctx.client.rpc('platform_move_member', {
      p: {
        user_id: person.userId,
        org_id: org.id,
        role,
        store_id: storeId || null,
        leave_others: leave,
      },
    });
    setConfirming(false);
    if (r.error) return setMsg({ kind: 'error', lines: [errText(r.error.code)] });
    const o = obj(r.data);
    const deleted = list(o.deleted).map((x) => str(x));
    const left = list(o.left).map((x) => str(x));
    const lines = [t.omDone];
    if (deleted.length) lines.push(fmt(t.omDoneDeleted, { list: deleted.join(', ') }));
    if (left.length) lines.push(fmt(t.omDoneLeft, { list: left.join(', ') }));
    setMsg({ kind: 'success', lines });
    setOrgId('');
    setStoreId('');
    reload();
    await find();
    setMsg({ kind: 'success', lines });
  };

  return (
    <div className="admin-page">
      <h1>{t.omTitle}</h1>
      <Notice kind="info">{t.omIntro}</Notice>
      {msg ? (
        <Notice kind={msg.kind}>
          {msg.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </Notice>
      ) : null}
      <section className="card admin-card">
        <div className="form-inline">
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            aria-label={t.omEmail}
            placeholder={t.omEmail}
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <AsyncButton onClick={find} disabled={email.trim().length < 3}>
            {t.omFind}
          </AsyncButton>
        </div>
      </section>

      {person ? (
        <section className="card admin-card">
          <h2>{fmt(t.omNowIn, { email: person.email })}</h2>
          {person.memberships.length === 0 ? (
            <p className="muted">{t.omNowNone}</p>
          ) : (
            <ul className="member-list">
              {person.memberships.map((m, i) => (
                <li key={`${m.orgName}-${i}`}>
                  <strong>{m.orgName}</strong> · {nameOfRole(m.role)} ·{' '}
                  {m.storeName ?? t.omAllShops} {m.active ? '' : t.omInactive}
                </li>
              ))}
            </ul>
          )}

          <h2>{t.omMoveTitle}</h2>
          {orgs.status === 'loading' ? (
            <p className="sso-working" role="status">
              <Spinner /> {t.loading}
            </p>
          ) : null}
          {orgs.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
          <div className="form-row">
            <label className="label" htmlFor="om-omOrg">
              {t.omOrg}
            </label>
            <select
              id="om-omOrg"
              className="field"
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setStoreId('');
                setConfirming(false);
              }}
            >
              <option value="">{t.omOrgPick}</option>
              {orgList.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({fmt(t.omOrgInfo, { shops: o.stores.length, people: o.staff })}
                  {o.empty ? `, ${t.omOrgEmpty}` : ''})
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="om-omRole">
              {t.omRole}
            </label>
            <select
              id="om-omRole"
              className="field"
              value={role}
              onChange={(e) => {
                setRole(e.target.value as RoleKey);
                setConfirming(false);
              }}
            >
              {ROLES.map((k) => (
                <option key={k} value={k}>
                  {roleLabel[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="om-omStore">
              {t.omStore}
            </label>
            <select
              id="om-omStore"
              className="field"
              value={storeId}
              onChange={(e) => {
                setStoreId(e.target.value);
                setConfirming(false);
              }}
            >
              <option value="">{t.omAllShops}</option>
              {(org?.stores ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={leave} onChange={(e) => setLeave(e.target.checked)} />{' '}
            {t.omLeave}
          </label>
          {confirming && org ? (
            <div className="form-inline">
              <AsyncButton onClick={move}>
                {fmt(t.omConfirm, { email: person.email, org: org.name, role: roleLabel[role] })}
              </AsyncButton>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(false)}
              >
                {t.omCancel}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!org}
              onClick={() => setConfirming(true)}
            >
              {t.omMove}
            </button>
          )}
        </section>
      ) : null}
    </div>
  );
}
