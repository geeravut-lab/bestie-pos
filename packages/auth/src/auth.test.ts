import { describe, expect, it, vi } from 'vitest';
import { authErrorCode, passwordChangeProblem, signUpProblem } from './errors';
import { appRoleFor, cleanOverrides, mapMembership, mapStore, pickStore } from './myContext';
import type { Membership, MyContext } from './myContext';
import { aivoraAuthorizeUrl, fetchEnabledProviders } from './providers';

describe('authErrorCode', () => {
  it('maps Supabase auth errors to err_* codes', () => {
    expect(authErrorCode({ code: 'invalid_credentials' })).toBe('err_auth_invalid');
    expect(authErrorCode({ message: 'Invalid login credentials' })).toBe('err_auth_invalid');
    expect(authErrorCode({ code: 'user_already_exists' })).toBe('err_auth_exists');
    expect(authErrorCode({ code: 'email_not_confirmed' })).toBe('err_auth_email_unconfirmed');
    expect(authErrorCode({ code: 'weak_password' })).toBe('err_weak_password');
    expect(authErrorCode({ status: 429 })).toBe('err_rate_limited');
    expect(
      authErrorCode({
        code: 'validation_failed',
        message: 'Unsupported provider: provider is not enabled',
      }),
    ).toBe('err_provider_disabled');
    expect(authErrorCode({ message: 'Failed to fetch' })).toBe('err_network');
  });

  it('degrades unknown errors to the generic message', () => {
    expect(authErrorCode({ code: 'weird' })).toBe('err_unknown');
    expect(authErrorCode(null)).toBe('err_unknown');
  });
});

describe('passwordChangeProblem', () => {
  const ok = { current: 'old-password', next: 'new-password-1', confirm: 'new-password-1' };
  it('accepts a valid change', () => expect(passwordChangeProblem(ok)).toBeNull());
  it('checks each rule in order', () => {
    expect(passwordChangeProblem({ ...ok, current: '' })).toBe('err_password_current_wrong');
    expect(passwordChangeProblem({ ...ok, next: 'short', confirm: 'short' })).toBe(
      'err_weak_password',
    );
    expect(passwordChangeProblem({ ...ok, next: 'x'.repeat(73), confirm: 'x'.repeat(73) })).toBe(
      'err_password_long',
    );
    expect(passwordChangeProblem({ ...ok, confirm: 'different-one' })).toBe(
      'err_password_mismatch',
    );
    expect(
      passwordChangeProblem({
        current: 'same-password',
        next: 'same-password',
        confirm: 'same-password',
      }),
    ).toBe('err_password_same');
  });
});

describe('signUpProblem', () => {
  it('needs a plausible e-mail and a long-enough password', () => {
    expect(signUpProblem('a@b.co', 'password1')).toBeNull();
    expect(signUpProblem('nope', 'password1')).toBe('err_invalid_input');
    expect(signUpProblem('a@b.co', 'short')).toBe('err_weak_password');
  });
});

const staffRow = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  org_id: 'o1',
  store_id: null,
  display_name: 'Nok',
  active: true,
  roles: {
    built_in: 'manager',
    name: 'Manager',
    permissions: ['order.create', 'bogus.permission', 'staff.manage'],
    hidden_modules: ['kds', 'not-a-module'],
  },
  orgs: { name: 'Acme', legal_sign_off: { cryptoTopup: true } },
  ...over,
});

describe('mapMembership', () => {
  it('maps a staff row and drops unknown permissions / modules', () => {
    const m = mapMembership(staffRow())!;
    expect(m).toMatchObject({
      orgId: 'o1',
      storeId: null,
      roleBuiltIn: 'manager',
      orgName: 'Acme',
    });
    expect(m.permissions).toEqual(['order.create', 'staff.manage']);
    expect(m.hiddenModules).toEqual(['kds']);
  });

  it('accepts joined rows as arrays (PostgREST can return either)', () => {
    const m = mapMembership(
      staffRow({
        roles: [{ built_in: 'cashier', name: 'Cashier', permissions: [], hidden_modules: [] }],
        orgs: [{ name: 'Acme', legal_sign_off: {} }],
      }),
    )!;
    expect(m.roleBuiltIn).toBe('cashier');
  });

  it('inactive or incomplete rows yield nothing', () => {
    expect(mapMembership(staffRow({ active: false }))).toBeNull();
    expect(mapMembership(staffRow({ roles: null }))).toBeNull();
  });

  it('only an explicit true opens the crypto legal gate', () => {
    expect(mapMembership(staffRow())!.legalSignOff.cryptoTopup).toBe(true);
    expect(
      mapMembership(staffRow({ orgs: { name: 'x', legal_sign_off: { cryptoTopup: 'true' } } }))!
        .legalSignOff.cryptoTopup,
    ).toBe(false);
    expect(
      mapMembership(staffRow({ orgs: { name: 'x', legal_sign_off: null } }))!.legalSignOff
        .cryptoTopup,
    ).toBe(false);
  });
});

describe('mapStore / cleanOverrides', () => {
  const row = {
    id: 'st1',
    org_id: 'o1',
    legal_entity_id: 'le1',
    name: 'Cafe',
    profile: 'cafe',
    plan: 'pro',
    module_overrides: { kds: false, 'queue.call': true, nope: true, 'tables.floorplan': 'yes' },
  };
  it('keeps only known boolean module overrides', () => {
    expect(cleanOverrides(row.module_overrides)).toEqual({ kds: false, 'queue.call': true });
    expect(cleanOverrides([1, 2])).toEqual({});
    expect(cleanOverrides(null)).toEqual({});
  });
  it('maps a store; unknown plan falls to the lowest tier, unknown profile or deleted store is dropped', () => {
    expect(mapStore(row, { cryptoTopup: false })).toMatchObject({
      id: 'st1',
      profile: 'cafe',
      plan: 'pro',
      legalEntityId: 'le1',
    });
    expect(mapStore({ ...row, plan: 'platinum' }, { cryptoTopup: false })!.plan).toBe('basic');
    expect(mapStore({ ...row, profile: 'bank' }, { cryptoTopup: false })).toBeNull();
    expect(mapStore({ ...row, deleted_at: '2026-01-01' }, { cryptoTopup: false })).toBeNull();
  });
});

describe('appRoleFor — the role comes from the org, never from how you logged in', () => {
  const m = (over: Partial<Membership>): Membership => ({
    staffId: 's',
    orgId: 'o',
    orgName: 'x',
    storeId: null,
    displayName: 'n',
    roleBuiltIn: null,
    roleName: 'r',
    permissions: [],
    hiddenModules: [],
    legalSignOff: { cryptoTopup: false },
    ...over,
  });
  it('built-in roles map 1:1', () => {
    expect(appRoleFor(m({ roleBuiltIn: 'owner' }), { app: 'pos', isPlatformAdmin: false })).toBe(
      'owner',
    );
    expect(appRoleFor(m({ roleBuiltIn: 'kitchen' }), { app: 'pos', isPlatformAdmin: false })).toBe(
      'kitchen',
    );
  });
  it('custom roles take the closest home from their permissions', () => {
    expect(
      appRoleFor(m({ permissions: ['staff.manage'] }), { app: 'pos', isPlatformAdmin: false }),
    ).toBe('manager');
    expect(
      appRoleFor(m({ permissions: ['payment.take'] }), { app: 'pos', isPlatformAdmin: false }),
    ).toBe('cashier');
    expect(
      appRoleFor(m({ permissions: ['order.create'] }), { app: 'pos', isPlatformAdmin: false }),
    ).toBe('waiter');
    expect(appRoleFor(m({}), { app: 'pos', isPlatformAdmin: false })).toBe('kitchen');
  });
  it('platform admins get the admin home only in the admin app', () => {
    expect(appRoleFor(undefined, { app: 'admin', isPlatformAdmin: true })).toBe('platformAdmin');
    expect(appRoleFor(m({ roleBuiltIn: 'owner' }), { app: 'pos', isPlatformAdmin: true })).toBe(
      'owner',
    );
  });
});

describe('pickStore', () => {
  const stores = [
    { id: 'a', orgId: 'o1' },
    { id: 'b', orgId: 'o1' },
    { id: 'c', orgId: 'o2' },
  ] as unknown as MyContext['stores'];
  const ctx = { profile: null, memberships: [], stores, isPlatformAdmin: false } as MyContext;
  it('uses the membership store, or the first store of the org for org-wide staff', () => {
    expect(pickStore(ctx, { orgId: 'o1', storeId: 'b' } as Membership)?.id).toBe('b');
    expect(pickStore(ctx, { orgId: 'o1', storeId: null } as Membership)?.id).toBe('a');
    expect(pickStore(ctx, { orgId: 'o3', storeId: null } as Membership)).toBeUndefined();
  });
});

describe('providers', () => {
  it('shows Google only when Supabase says it is enabled', async () => {
    const f = (external: unknown) =>
      vi.fn(async () => new Response(JSON.stringify({ external }))) as unknown as typeof fetch;
    expect(await fetchEnabledProviders('https://x', 'k', f({ google: true }))).toEqual({
      google: true,
    });
    expect(await fetchEnabledProviders('https://x', 'k', f({ google: false }))).toEqual({
      google: false,
    });
    const broken = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchEnabledProviders('https://x', 'k', broken)).toEqual({ google: false });
  });

  it('builds the hub authorize URL with an encoded callback', () => {
    expect(
      aivoraAuthorizeUrl(
        'https://hub.example/',
        'bestie pos',
        'https://bestie-pos.vercel.app/sso/callback',
      ),
    ).toBe(
      'https://hub.example/sso/authorize?app=bestie%20pos&return=https%3A%2F%2Fbestie-pos.vercel.app%2Fsso%2Fcallback',
    );
  });
});
