import type { SupabaseClient } from '@supabase/supabase-js';
import { MODULE_IDS, PERMISSIONS, cleanModuleOverrides, parseTheme } from '@bestie/core';
import type {
  BuiltInRoleKey,
  LegalSignOff,
  ModuleId,
  Permission,
  PlanTier,
  StoreModuleConfig,
  StoreTheme,
} from '@bestie/core';
import type { AppRole } from '@bestie/ui';
import type { BusinessProfile } from '@bestie/core';

/** Who is signed in, where they work and what they may do — assembled from RLS-filtered rows. */
export type Membership = {
  staffId: string;
  orgId: string;
  orgName: string;
  /** null = works in every store of the org. */
  storeId: string | null;
  displayName: string;
  roleBuiltIn: BuiltInRoleKey | null;
  roleName: string;
  permissions: Permission[];
  hiddenModules: ModuleId[];
  legalSignOff: LegalSignOff;
};

export type StoreInfo = StoreModuleConfig & {
  /** The owner's chosen colours (empty = the built-in palette). */
  theme: StoreTheme;
  id: string;
  orgId: string;
  name: string;
  legalEntityId: string;
};

export type MyContext = {
  profile: { displayName: string | null; language: 'th' | 'en' } | null;
  memberships: Membership[];
  stores: StoreInfo[];
  isPlatformAdmin: boolean;
};

type Row = Record<string, unknown>;
const one = <T>(v: T | T[] | null | undefined): T | undefined =>
  Array.isArray(v) ? v[0] : (v ?? undefined);
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const BUILT_IN: readonly string[] = ['owner', 'manager', 'cashier', 'waiter', 'kitchen'];

export function mapMembership(row: Row): Membership | null {
  if (row.active === false) return null;
  const role = one(row.roles as Row | Row[] | undefined);
  const org = one(row.orgs as Row | Row[] | undefined);
  if (!role || !org || typeof row.id !== 'string' || typeof row.org_id !== 'string') return null;
  const sign = (org.legal_sign_off ?? {}) as Row;
  return {
    staffId: row.id,
    orgId: row.org_id,
    orgName: String(org.name ?? ''),
    storeId: typeof row.store_id === 'string' ? row.store_id : null,
    displayName: String(row.display_name ?? ''),
    roleBuiltIn: BUILT_IN.includes(String(role.built_in))
      ? (role.built_in as BuiltInRoleKey)
      : null,
    roleName: String(role.name ?? ''),
    permissions: asStrings(role.permissions).filter((p): p is Permission =>
      (PERMISSIONS as readonly string[]).includes(p),
    ),
    hiddenModules: asStrings(role.hidden_modules).filter((m): m is ModuleId =>
      (MODULE_IDS as readonly string[]).includes(m),
    ),
    // Only an explicit `true` counts: a missing / garbled value must never open the legal gate.
    legalSignOff: { cryptoTopup: sign.cryptoTopup === true },
  };
}

export const cleanOverrides = cleanModuleOverrides;

const PROFILES: readonly string[] = [
  'restaurant',
  'cafe',
  'salon',
  'spa',
  'resort',
  'retail',
  'tours',
  'karaoke',
];
const PLANS: readonly string[] = ['basic', 'pro', 'resort'];

export function mapStore(row: Row, legalSignOff: LegalSignOff): StoreInfo | null {
  if (typeof row.id !== 'string' || typeof row.org_id !== 'string' || row.deleted_at) return null;
  if (!PROFILES.includes(String(row.profile))) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    name: String(row.name ?? ''),
    legalEntityId: String(row.legal_entity_id ?? ''),
    profile: row.profile as BusinessProfile,
    plan: (PLANS.includes(String(row.plan)) ? row.plan : 'basic') as PlanTier, // unknown plan → lowest, never highest
    moduleOverrides: cleanOverrides(row.module_overrides),
    legalSignOff,
    theme: parseTheme(row.theme),
  };
}

/** Which role-home / menu set to show. Login never decides this — the org's role assignment does. */
export function appRoleFor(
  m: Membership | undefined,
  opts: { app: 'pos' | 'admin' | 'guest'; isPlatformAdmin: boolean },
): AppRole {
  if (opts.app === 'admin' && opts.isPlatformAdmin) return 'platformAdmin';
  if (!m) return opts.app === 'guest' ? 'guest' : 'cashier';
  if (m.roleBuiltIn) return m.roleBuiltIn;
  // custom role: infer the closest home from its permissions
  if (m.permissions.includes('staff.manage')) return 'manager';
  if (m.permissions.includes('payment.take')) return 'cashier';
  if (m.permissions.includes('order.create')) return 'waiter';
  return 'kitchen';
}

/**
 * The signed-in person's own shop data. The staff table lets every member see the WHOLE team of their shop (the Team page
 * needs that), so the query must ask for THIS user's rows only: without the filter the first row (the owner's) was taken as
 * "my role" and a cashier saw the owner's home screen and carried the owner's permissions in the screens.
 */
export async function loadMyContext(client: SupabaseClient, userId: string): Promise<MyContext> {
  const [profile, staff, stores, admin, flags] = await Promise.all([
    client.from('profiles').select('display_name, language').maybeSingle(),
    client
      .from('staff')
      .select(
        'id, user_id, org_id, store_id, display_name, active, roles(built_in, name, permissions, hidden_modules), orgs(name, legal_sign_off)',
      )
      .eq('user_id', userId)
      .eq('active', true),
    client
      .from('stores')
      .select(
        'id, org_id, legal_entity_id, name, profile, plan, module_overrides, theme, deleted_at',
      )
      .is('deleted_at', null),
    client.rpc('is_platform_admin'),
    client.from('platform_flags').select('module_id'), // modules the platform administrator switched off for everybody
  ]);
  if (staff.error) throw new Error(`staff: ${staff.error.code ?? 'error'}`);
  if (stores.error) throw new Error(`stores: ${stores.error.code ?? 'error'}`);

  const memberships = ((staff.data ?? []) as Row[])
    .filter((r) => r.user_id === userId) // belt and braces: never trust that the server already filtered
    .map(mapMembership)
    .filter((m): m is Membership => m !== null);
  const killed: Record<string, boolean> = {};
  for (const f of (flags.error ? [] : (flags.data ?? [])) as { module_id?: unknown }[])
    if (typeof f.module_id === 'string') killed[f.module_id] = false; // a platform switch beats the shop's own
  const legalByOrg = new Map(memberships.map((m) => [m.orgId, m.legalSignOff]));
  const storeInfos = ((stores.data ?? []) as Row[])
    .map((r) => mapStore(r, legalByOrg.get(String(r.org_id)) ?? { cryptoTopup: false }))
    .filter((s): s is StoreInfo => s !== null)
    .map((s) => ({ ...s, moduleOverrides: { ...s.moduleOverrides, ...killed } }));

  const p = profile.data as Row | null;
  return {
    profile: p
      ? {
          displayName: (p.display_name as string | null) ?? null,
          language: p.language === 'en' ? 'en' : 'th',
        }
      : null,
    memberships,
    stores: storeInfos,
    isPlatformAdmin: admin.data === true,
  };
}

/** The store to work in: the membership's own store, else the org's first store. */
export function pickStore(ctx: MyContext, m: Membership | undefined): StoreInfo | undefined {
  if (!m) return undefined;
  return ctx.stores.find((s) => s.orgId === m.orgId && (m.storeId === null || s.id === m.storeId));
}
