import { useState } from 'react';
import { formatInviteCode, isValidPin, isWeakPin } from '@bestie/core';
import { errorText, fmt, formatDate, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type RoleRow = { id: string; name: string; built_in: string | null };
type StaffRow = {
  id: string;
  store_id: string | null;
  display_name: string;
  role_id: string;
  active: boolean;
};
type StoreRow = { id: string; name: string };
type InviteRow = {
  id: string;
  display_name: string;
  role_id: string;
  store_id: string | null;
  expires_at: string;
};

const BUILT_IN_LABEL = (t: Dict, b: string | null, fallback: string): string =>
  b === 'owner'
    ? t.roleOwner
    : b === 'manager'
      ? t.roleManager
      : b === 'cashier'
        ? t.roleCashier
        : b === 'waiter'
          ? t.roleWaiter
          : b === 'kitchen'
            ? t.roleKitchen
            : fallback;

/** A database error code → the sentence key the person sees. */
const saveError = (code: string | undefined): ErrorKey =>
  code === '42501' ? 'err_owner_only' : code === '23514' ? 'err_forbidden' : 'err_save_failed';

/** Owner / manager: the team, roles, per-person PIN and one-time invite codes. */
export function StaffPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canManage = ctx.isOwner || ctx.permissions.includes('staff.manage');
  const { status, data, reload } = useRemote(async () => {
    const [roles, staff, stores, invites] = await Promise.all([
      ctx.client
        .from('roles')
        .select('id, name, built_in')
        .eq('org_id', ctx.orgId)
        .order('created_at'),
      ctx.client
        .from('staff')
        .select('id, store_id, display_name, role_id, active')
        .eq('org_id', ctx.orgId)
        .order('created_at'),
      ctx.client
        .from('stores')
        .select('id, name')
        .eq('org_id', ctx.orgId)
        .is('deleted_at', null)
        .order('created_at'),
      canManage
        ? ctx.client
            .from('staff_invites')
            .select('id, display_name, role_id, store_id, expires_at')
            .eq('org_id', ctx.orgId)
            .is('used_at', null)
            .gt('expires_at', new Date().toISOString())
            .order('created_at')
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (roles.error || staff.error || stores.error || invites.error) throw new Error('load');
    return {
      roles: (roles.data ?? []) as RoleRow[],
      staff: (staff.data ?? []) as StaffRow[],
      stores: (stores.data ?? []) as StoreRow[],
      invites: (invites.data ?? []) as InviteRow[],
    };
  }, `${ctx.orgId}:${canManage}`);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  }
  // a manager can neither hand out nor touch the owner role (the database enforces it too)
  const assignable = ctx.isOwner ? data.roles : data.roles.filter((r) => r.built_in !== 'owner');
  return (
    <div className="admin-page">
      <h1>{t.staffTitle}</h1>
      <Notice kind="info">{t.staffIntro}</Notice>
      <Members
        ctx={ctx}
        data={data}
        assignable={assignable}
        canManage={canManage}
        onChanged={reload}
      />
      {canManage ? (
        <>
          <InviteCard ctx={ctx} data={data} assignable={assignable} onChanged={reload} />
          <PendingInvites ctx={ctx} data={data} onChanged={reload} />
        </>
      ) : null}
    </div>
  );
}

type Data = { roles: RoleRow[]; staff: StaffRow[]; stores: StoreRow[]; invites: InviteRow[] };

function Members({
  ctx,
  data,
  assignable,
  canManage,
  onChanged,
}: {
  ctx: PageContext;
  data: Data;
  assignable: RoleRow[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const roleById = new Map(data.roles.map((r) => [r.id, r]));
  const storeName = (id: string | null) =>
    id === null ? t.staffAllStores : (data.stores.find((s) => s.id === id)?.name ?? '—');
  return (
    <section className="card admin-card">
      <h2>{t.staffMembers}</h2>
      <ul className="member-list">
        {data.staff.map((m) => {
          const role = roleById.get(m.role_id);
          const ownerRow = role?.built_in === 'owner';
          const locked = !canManage || (ownerRow && !ctx.isOwner);
          return (
            <li key={m.id} className="member-row">
              <div className="member-head">
                <strong>{m.display_name}</strong>
                <span className="muted">{storeName(m.store_id)}</span>
                {!m.active ? <span className="badge">{t.staffInactive}</span> : null}
              </div>
              <MemberRoleAndState
                ctx={ctx}
                member={m}
                role={role}
                assignable={assignable}
                locked={locked}
                onChanged={onChanged}
              />
              {!locked ? <PinForm ctx={ctx} staffId={m.id} name={m.display_name} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MemberRoleAndState({
  ctx,
  member,
  role,
  assignable,
  locked,
  onChanged,
}: {
  ctx: PageContext;
  member: StaffRow;
  role: RoleRow | undefined;
  assignable: RoleRow[];
  locked: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const update = async (values: { role_id?: string; active?: boolean }) => {
    setError(null);
    setSaved(false);
    const { data: rows, error: err } = await ctx.client
      .from('staff')
      .update(values)
      .eq('id', member.id)
      .select('id');
    if (err || rows?.length !== 1) return setError(saveError(err?.code));
    setSaved(true);
    onChanged();
  };

  return (
    <div className="member-controls">
      <div className="form-row">
        <label className="label" htmlFor={`role-${member.id}`}>
          {t.staffRole}
        </label>
        <select
          id={`role-${member.id}`}
          className="field"
          value={member.role_id}
          disabled={locked}
          onChange={(e) => void update({ role_id: e.target.value })}
        >
          {role && !assignable.some((r) => r.id === role.id) ? (
            <option value={role.id}>{BUILT_IN_LABEL(t, role.built_in, role.name)}</option>
          ) : null}
          {assignable.map((r) => (
            <option key={r.id} value={r.id}>
              {BUILT_IN_LABEL(t, r.built_in, r.name)}
            </option>
          ))}
        </select>
      </div>
      {!locked ? (
        <AsyncButton variant="secondary" onClick={() => update({ active: !member.active })}>
          {member.active ? t.staffDeactivate : t.staffReactivate}
        </AsyncButton>
      ) : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.staffSaved}</Notice> : null}
    </div>
  );
}

function PinForm({ ctx, staffId, name }: { ctx: PageContext; staffId: string; name: string }) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setError(null);
    setSaved(false);
    if (!isValidPin(pin)) return setError('err_pin_invalid');
    const { error: err } = await ctx.client.rpc('set_staff_pin', { p_staff: staffId, p_pin: pin });
    if (err) return setError(saveError(err.code));
    setPin(''); // never keep a PIN in the screen after it is saved
    setSaved(true);
  };

  return (
    <form className="pin-form" onSubmit={(e) => e.preventDefault()}>
      <div className="form-row">
        <label className="label" htmlFor={`pin-${staffId}`}>
          {t.staffPinLabel}
          <span className="visually-hidden"> — {name}</span>
        </label>
        <input
          id={`pin-${staffId}`}
          className="field tabular"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={8}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, ''));
            setSaved(false);
          }}
        />
      </div>
      {isWeakPin(pin) ? <p className="muted">{t.staffPinWeak}</p> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.staffPinSaved}</Notice> : null}
      <AsyncButton type="submit" variant="secondary" onClick={save}>
        {t.staffPinSave}
      </AsyncButton>
    </form>
  );
}

function InviteCard({
  ctx,
  data,
  assignable,
  onChanged,
}: {
  ctx: PageContext;
  data: Data;
  assignable: RoleRow[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const invitable = assignable.length > 0 ? assignable : data.roles;
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState(
    invitable.find((r) => r.built_in === 'cashier')?.id ?? invitable[0]?.id ?? '',
  );
  const [storeId, setStoreId] = useState<string>('');
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  const create = async () => {
    setError(null);
    setCode(null);
    setCopied(false);
    if (name.trim().length < 1 || !roleId) return setError('err_invalid_input');
    const { data: made, error: err } = await ctx.client.rpc('create_staff_invite', {
      p_org: ctx.orgId,
      p_store: storeId === '' ? null : storeId,
      p_role: roleId,
      p_name: name.trim(),
    });
    if (err || typeof made !== 'string') return setError(saveError(err?.code));
    setCode(formatInviteCode(made));
    setName('');
    onChanged();
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false); // the code is on screen; copying by hand still works
    }
  };

  return (
    <section className="card admin-card">
      <h2>{t.inviteTitle}</h2>
      <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
        <div className="filters">
          <div className="form-row">
            <label className="label" htmlFor="inv-name">
              {t.inviteName}
            </label>
            <input
              id="inv-name"
              className="field"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="inv-role">
              {t.inviteRole}
            </label>
            <select
              id="inv-role"
              className="field"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
            >
              {invitable.map((r) => (
                <option key={r.id} value={r.id}>
                  {BUILT_IN_LABEL(t, r.built_in, r.name)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="inv-store">
              {t.inviteScope}
            </label>
            <select
              id="inv-store"
              className="field"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
            >
              <option value="">{t.staffAllStores}</option>
              {data.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        <AsyncButton type="submit" onClick={create}>
          {t.inviteCreate}
        </AsyncButton>
      </form>
      {code ? (
        <div className="invite-code-box">
          <Notice kind="success">{fmt(t.inviteCodeShown, { code })}</Notice>
          <p className="invite-code mono" aria-label={t.inviteCopy}>
            {code}
          </p>
          <AsyncButton variant="secondary" onClick={copy}>
            {copied ? t.inviteCopied : t.inviteCopy}
          </AsyncButton>
        </div>
      ) : null}
    </section>
  );
}

function PendingInvites({
  ctx,
  data,
  onChanged,
}: {
  ctx: PageContext;
  data: Data;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const [error, setError] = useState<ErrorKey | null>(null);
  const revoke = async (id: string) => {
    setError(null);
    const { error: err } = await ctx.client.rpc('revoke_staff_invite', { p_invite: id });
    if (err) return setError(saveError(err.code));
    onChanged();
  };
  const roleName = (id: string) => {
    const r = data.roles.find((x) => x.id === id);
    return r ? BUILT_IN_LABEL(t, r.built_in, r.name) : '—';
  };
  return (
    <section className="card admin-card">
      <h2>{t.invitePending}</h2>
      {data.invites.length === 0 ? <p className="muted">{t.inviteNone}</p> : null}
      <ul className="member-list">
        {data.invites.map((i) => (
          <li key={i.id} className="member-row">
            <div className="member-head">
              <strong>{i.display_name}</strong>
              <span className="muted">{roleName(i.role_id)}</span>
              <span className="muted">
                {fmt(t.inviteExpires, { date: formatDate(lang, i.expires_at) })}
              </span>
            </div>
            <AsyncButton variant="secondary" onClick={() => revoke(i.id)}>
              {t.inviteRevoke}
            </AsyncButton>
          </li>
        ))}
      </ul>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
    </section>
  );
}
