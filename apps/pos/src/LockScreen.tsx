import { useEffect, useState } from 'react';
import { MODULE_IDS, PERMISSIONS } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { AuthFrame, Notice, useAuth } from '@bestie/auth';
import type { ActingIdentity, PageContext } from '@bestie/auth';
import { cachedRead } from '@bestie/offline';
import type { DeviceBinding } from '@bestie/offline';
import { unlockWithPin } from './unlock';

export type Person = Omit<ActingIdentity, 'accountId'>;
type Loaded = { people: Person[]; deviceActive: boolean };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const one = <T,>(v: T | T[] | null | undefined): T | undefined =>
  Array.isArray(v) ? v[0] : (v ?? undefined);

/** Everyone on this till's shop who has a PIN, plus whether the back office still lets this device run. */
export async function loadPeople(ctx: PageContext, binding: DeviceBinding): Promise<Loaded> {
  const [staff, pins, device] = await Promise.all([
    ctx.client
      .from('staff')
      .select('id, store_id, display_name, roles(built_in, name, permissions, hidden_modules)')
      .eq('org_id', ctx.orgId)
      .eq('active', true),
    ctx.client.rpc('staff_with_pin', { p_org: ctx.orgId }),
    ctx.client.from('devices').select('active').eq('id', binding.deviceId).maybeSingle(),
  ]);
  if (staff.error || pins.error || device.error) throw new Error('load');
  const withPin = new Set(strings(pins.data));
  const people: Person[] = [];
  for (const r of (staff.data ?? []) as unknown as Record<string, unknown>[]) {
    const id = String(r.id);
    const storeId = r.store_id;
    if (!withPin.has(id) || (typeof storeId === 'string' && storeId !== binding.storeId)) continue;
    const role = one(r.roles as Record<string, unknown> | Record<string, unknown>[] | undefined);
    if (!role) continue;
    people.push({
      staffId: id,
      displayName: String(r.display_name ?? ''),
      roleName: String(role.name ?? ''),
      roleBuiltIn: ['owner', 'manager', 'cashier', 'waiter', 'kitchen'].includes(
        String(role.built_in),
      )
        ? (role.built_in as Person['roleBuiltIn'])
        : null,
      permissions: strings(role.permissions).filter((p): p is (typeof PERMISSIONS)[number] =>
        (PERMISSIONS as readonly string[]).includes(p),
      ),
      hiddenModules: strings(role.hidden_modules).filter((m): m is (typeof MODULE_IDS)[number] =>
        (MODULE_IDS as readonly string[]).includes(m),
      ),
    });
  }
  people.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { people, deviceActive: (device.data as { active?: boolean } | null)?.active !== false };
}

/**
 * The till's "who's working?" screen. `onOpen` is called with the loaded list so the app can decide to let the account
 * through when nobody has a PIN yet (otherwise the owner could never reach the Team page to set one).
 */
export function LockScreen({
  ctx,
  binding,
  onUnlock,
}: {
  ctx: PageContext;
  binding: DeviceBinding;
  onUnlock: (a: ActingIdentity | 'open') => void;
}) {
  const { t } = useI18n();
  const accountId = useAuth().user?.id ?? '';
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & Loaded)
  >({ status: 'loading' });
  const [person, setPerson] = useState<Person | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);

  useEffect(() => {
    let alive = true;
    // network first, last good copy when offline — the lock screen must open with no signal
    cachedRead(`lock:${binding.storeId}`, () => loadPeople(ctx, binding)).then(
      ({ data }) => {
        if (!alive) return;
        if (data.people.length === 0) return onUnlock('open'); // nobody has a PIN yet: setup mode
        setState({ status: 'ready', ...data });
      },
      () => alive && setState({ status: 'error' }),
    );
    return () => {
      alive = false;
    };
    // the list is read once per lock screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding.storeId, binding.deviceId, ctx.orgId]);

  const submit = async () => {
    if (!person) return;
    setError(null);
    const online = globalThis.navigator?.onLine !== false;
    const r = await unlockWithPin(ctx.client, person.staffId, pin, online);
    setPin('');
    if (r === 'ok') return onUnlock({ ...person, accountId });
    setError(
      r === 'wrong'
        ? 'err_pin_wrong'
        : r === 'locked'
          ? 'err_pin_locked'
          : r === 'no_pin'
            ? 'err_pin_not_set'
            : 'err_pin_unknown_offline',
    );
  };

  const press = (d: string) => setPin((p) => (p.length < 8 ? p + d : p));
  const offline = globalThis.navigator?.onLine === false;

  return (
    <AuthFrame>
      <section className="card auth-card">
        <h1>{t.lockTitle}</h1>
        <p className="muted">{binding.name}</p>
        {offline ? <Notice kind="info">{t.lockOfflineNote}</Notice> : null}
        {state.status === 'loading' ? (
          <p className="sso-working" role="status">
            <Spinner /> {t.loading}
          </p>
        ) : state.status === 'error' ? (
          <Notice kind="error">{t.err_load_failed}</Notice>
        ) : !state.deviceActive ? (
          <Notice kind="error">{t.lockDeviceOff}</Notice>
        ) : person === null ? (
          <>
            <p className="muted">{t.lockPickPerson}</p>
            <div className="lock-grid">
              {state.people.map((p) => (
                <button
                  key={p.staffId}
                  type="button"
                  className="lock-person"
                  onClick={() => {
                    setPerson(p);
                    setPin('');
                    setError(null);
                  }}
                >
                  <span>{p.displayName}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
            <p>
              <strong>{fmt(t.lockEnterPin, { name: person.displayName })}</strong>
            </p>
            <div className="pin-dots" aria-hidden="true">
              {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
                <span key={i} data-on={i < pin.length} />
              ))}
            </div>
            <div className="form-row">
              <label className="label" htmlFor="lock-pin">
                {t.lockPinLabel}
              </label>
              <input
                id="lock-pin"
                className="field tabular"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="pin-pad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" aria-label={d} onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button type="button" aria-label="⌫" onClick={() => setPin((p) => p.slice(0, -1))}>
                ⌫
              </button>
              <button type="button" aria-label="0" onClick={() => press('0')}>
                0
              </button>
            </div>
            {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
            <div className="actions">
              <AsyncButton type="submit" disabled={pin.length < 4} onClick={submit}>
                {t.lockUnlock}
              </AsyncButton>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setPerson(null);
                  setPin('');
                  setError(null);
                }}
              >
                {t.lockOther}
              </button>
            </div>
          </form>
        )}
        <p className="muted">{t.lockWrongDevice}</p>
      </section>
    </AuthFrame>
  );
}
