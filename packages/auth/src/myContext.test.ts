import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { appRoleFor, loadMyContext } from './myContext';

const ME = 'user-cashier';
const OWNER = 'user-owner';
const row = (id: string, user: string, built_in: string, perms: string[]) => ({
  id,
  user_id: user,
  org_id: 'o1',
  store_id: null,
  display_name: id,
  active: true,
  roles: { built_in, name: built_in, permissions: perms, hidden_modules: [] },
  orgs: { name: 'VC Group', legal_sign_off: {} },
});
const OWNER_ROW = row('s-owner', OWNER, 'owner', ['staff.manage', 'menu.edit', 'report.view']);
const CASHIER_ROW = row('s-cashier', ME, 'cashier', ['order.create', 'payment.take']);

/** A client whose staff table shows the WHOLE team (as the real policy does), owner first — unless the query filters by user. */
function client(filterByUserHonoured = true) {
  const eqs: [string, unknown][] = [];
  const staff = {
    select: () => staff,
    eq: (col: string, val: unknown) => {
      eqs.push([col, val]);
      return staff;
    },
    then: (resolve: (v: unknown) => void) => {
      const asked = eqs.find(([c]) => c === 'user_id');
      const rows = [OWNER_ROW, CASHIER_ROW];
      resolve({
        data: asked && filterByUserHonoured ? rows.filter((r) => r.user_id === asked[1]) : rows,
        error: null,
      });
    },
  };
  const empty = {
    select: () => empty,
    is: () => empty,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
  };
  const c = {
    from: vi.fn((t: string) => (t === 'staff' ? staff : empty)),
    rpc: vi.fn(async () => ({ data: false, error: null })),
  };
  return { client: c as unknown as SupabaseClient, eqs };
}

describe('loadMyContext: my role is MY role', () => {
  it('asks for this user’s staff rows only', async () => {
    const { client: c, eqs } = client();
    await loadMyContext(c, ME);
    expect(eqs).toContainEqual(['user_id', ME]);
  });

  it('a cashier gets the cashier membership, not the owner’s (even though the owner’s row is listed first)', async () => {
    const { client: c } = client();
    const my = await loadMyContext(c, ME);
    expect(my.memberships).toHaveLength(1);
    expect(my.memberships[0]).toMatchObject({ staffId: 's-cashier', roleBuiltIn: 'cashier' });
    expect(my.memberships[0]!.permissions).not.toContain('staff.manage');
    expect(appRoleFor(my.memberships[0], { app: 'pos', isPlatformAdmin: false })).toBe('cashier');
  });

  it('even if the server ignored the filter, other people’s rows are dropped', async () => {
    const { client: c } = client(false);
    const my = await loadMyContext(c, ME);
    expect(my.memberships.map((m) => m.staffId)).toEqual(['s-cashier']);
    const owner = await loadMyContext(c, OWNER);
    expect(owner.memberships.map((m) => m.roleBuiltIn)).toEqual(['owner']);
  });
});

describe('loadMyContext: platform switches', () => {
  const table = (rows: unknown[]) => {
    const t: Record<string, unknown> = {};
    t.select = () => t;
    t.eq = () => t;
    t.is = () => t;
    t.maybeSingle = async () => ({ data: null, error: null });
    t.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
    return t;
  };
  const make = (flags: unknown, flagsError = false) =>
    ({
      from: (name: string) =>
        name === 'staff'
          ? table([CASHIER_ROW])
          : name === 'stores'
            ? table([
                {
                  id: 'st1',
                  org_id: 'o1',
                  legal_entity_id: 'l1',
                  name: 'Cafe',
                  profile: 'cafe',
                  plan: 'pro',
                  module_overrides: { kiosk: true, marketing: true },
                  theme: null,
                  deleted_at: null,
                },
              ])
            : name === 'platform_flags'
              ? flagsError
                ? {
                    select: () => ({
                      then: (r: (v: unknown) => void) =>
                        r({ data: null, error: { code: '42P01' } }),
                    }),
                  }
                : table(flags as unknown[])
              : table([]),
      rpc: async () => ({ data: false, error: null }),
    }) as unknown as SupabaseClient;

  it('a module the platform administrator switched off is off in every shop, whatever the shop chose', async () => {
    const my = await loadMyContext(make([{ module_id: 'kiosk' }]), ME);
    expect(my.stores[0]!.moduleOverrides).toEqual({ kiosk: false, marketing: true });
  });
  it('without switches (or when they cannot be read) the shop keeps its own choices', async () => {
    expect((await loadMyContext(make([]), ME)).stores[0]!.moduleOverrides).toEqual({
      kiosk: true,
      marketing: true,
    });
    expect((await loadMyContext(make(null, true), ME)).stores[0]!.moduleOverrides).toEqual({
      kiosk: true,
      marketing: true,
    });
  });
});
