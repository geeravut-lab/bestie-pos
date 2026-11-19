/**
 * Module registry — CLAUDE.md rule 6: feature flags are DATA. Every module has an id, dependencies,
 * default-on profiles and a plan tier. UI and API both ask `isEnabled(...)` (see ./enabled.ts).
 * Source of truth for the toggle matrix in docs/PRODUCT_SPEC.md §5.
 *
 * `●` in the matrix = listed in `defaultProfiles`; `○` = available (not listed, can be switched on).
 */
import type { BusinessProfile } from '../profiles';

export type PlanTier = 'basic' | 'pro' | 'resort';
/** basic ⊂ pro ⊂ resort: a higher plan includes everything below it. */
export const PLAN_RANK: Record<PlanTier, number> = { basic: 0, pro: 1, resort: 2 };

export const MODULE_IDS = [
  // operations
  'tables.floorplan',
  'bill.split',
  'queue.call',
  'kds',
  'order.qr',
  'kiosk',
  'delivery',
  'service.charge',
  // services / bookings
  'appointments',
  'resources',
  'deposits',
  'commission',
  'packages',
  'booking.online',
  'slots.booking',
  // resort
  'folio',
  'pms',
  // back office
  'stock',
  'recipe.cost',
  // customers & tenders
  'loyalty.network',
  'tender.promptpay',
  'tender.gateway',
  'tender.credit',
  'tender.points',
  'credit.topup.crypto',
  // platform
  'ai.assistant',
  'ai.guest',
  'line.notify',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export type ModuleDef = {
  id: ModuleId;
  /** Modules that must be on whenever this one is on. Enabling auto-enables them. */
  dependsOn: readonly ModuleId[];
  /** Profiles where the module is on by default (● in the matrix). */
  defaultProfiles: readonly BusinessProfile[];
  plan: PlanTier;
  /** Needs a legal sign-off on the org record before it can ever be enabled. */
  legalGate?: 'cryptoTopup';
  /** Phase in which the module is actually built (docs/PRODUCT_SPEC.md §8). Informational. */
  phase: 1 | 2 | 3 | 4;
};

const ALL: readonly BusinessProfile[] = [
  'restaurant',
  'cafe',
  'salon',
  'spa',
  'resort',
  'retail',
  'tours',
];

export const MODULES: readonly ModuleDef[] = [
  {
    id: 'tables.floorplan',
    dependsOn: [],
    defaultProfiles: ['restaurant', 'resort'],
    plan: 'basic',
    phase: 1,
  },
  {
    id: 'bill.split',
    dependsOn: [],
    defaultProfiles: ['restaurant', 'spa', 'resort'],
    plan: 'basic',
    phase: 1,
  },
  { id: 'queue.call', dependsOn: [], defaultProfiles: ['cafe'], plan: 'basic', phase: 1 },
  {
    id: 'kds',
    dependsOn: [],
    defaultProfiles: ['restaurant', 'cafe', 'resort'],
    plan: 'pro',
    phase: 1,
  },
  {
    id: 'order.qr',
    dependsOn: [],
    defaultProfiles: ['restaurant', 'resort'],
    plan: 'pro',
    phase: 1,
  },
  { id: 'kiosk', dependsOn: [], defaultProfiles: [], plan: 'pro', phase: 4 },
  { id: 'delivery', dependsOn: [], defaultProfiles: [], plan: 'pro', phase: 4 },
  {
    id: 'service.charge',
    dependsOn: [],
    defaultProfiles: ['restaurant', 'resort'],
    plan: 'basic',
    phase: 1,
  },

  { id: 'appointments', dependsOn: [], defaultProfiles: ['salon', 'spa'], plan: 'pro', phase: 2 },
  {
    id: 'resources',
    dependsOn: ['appointments'],
    defaultProfiles: ['spa', 'resort'],
    plan: 'pro',
    phase: 2,
  },
  // "deposits need appointments" (PRODUCT_SPEC §3): a table reservation is an appointment too.
  {
    id: 'deposits',
    dependsOn: ['appointments'],
    defaultProfiles: ['salon', 'spa', 'resort', 'tours'],
    plan: 'pro',
    phase: 2,
  },
  { id: 'commission', dependsOn: [], defaultProfiles: ['salon', 'spa'], plan: 'pro', phase: 2 },
  { id: 'packages', dependsOn: [], defaultProfiles: ['salon', 'spa'], plan: 'pro', phase: 2 },
  { id: 'booking.online', dependsOn: ['appointments'], defaultProfiles: [], plan: 'pro', phase: 2 },
  { id: 'slots.booking', dependsOn: [], defaultProfiles: ['tours'], plan: 'pro', phase: 2 },

  { id: 'folio', dependsOn: [], defaultProfiles: ['resort'], plan: 'resort', phase: 4 },
  { id: 'pms', dependsOn: ['folio'], defaultProfiles: [], plan: 'resort', phase: 4 },

  { id: 'stock', dependsOn: [], defaultProfiles: ['salon', 'retail'], plan: 'basic', phase: 1 },
  {
    id: 'recipe.cost',
    dependsOn: ['stock'],
    defaultProfiles: ['restaurant', 'cafe'],
    plan: 'pro',
    phase: 1,
  },

  { id: 'loyalty.network', dependsOn: [], defaultProfiles: ALL, plan: 'basic', phase: 1 },
  { id: 'tender.promptpay', dependsOn: [], defaultProfiles: ALL, plan: 'basic', phase: 1 },
  { id: 'tender.gateway', dependsOn: [], defaultProfiles: [], plan: 'basic', phase: 1 },
  // Credit stays opt-in until the lawyer confirms the single-entity prepaid structure (DECISIONS.md).
  { id: 'tender.credit', dependsOn: [], defaultProfiles: [], plan: 'basic', phase: 1 },
  {
    id: 'tender.points',
    dependsOn: ['loyalty.network'],
    defaultProfiles: ALL,
    plan: 'basic',
    phase: 1,
  },
  {
    id: 'credit.topup.crypto',
    dependsOn: ['tender.credit'],
    defaultProfiles: [], // OFF by default, always (CLAUDE.md rule 3)
    plan: 'basic',
    legalGate: 'cryptoTopup',
    phase: 3,
  },

  { id: 'ai.assistant', dependsOn: [], defaultProfiles: [], plan: 'pro', phase: 1 },
  { id: 'ai.guest', dependsOn: ['order.qr'], defaultProfiles: [], plan: 'pro', phase: 1 },
  { id: 'line.notify', dependsOn: [], defaultProfiles: [], plan: 'basic', phase: 1 },
];

export const MODULE_BY_ID: Readonly<Record<ModuleId, ModuleDef>> = Object.fromEntries(
  MODULES.map((m) => [m.id, m]),
) as Record<ModuleId, ModuleDef>;

export const isModuleId = (v: unknown): v is ModuleId =>
  typeof v === 'string' && (MODULE_IDS as readonly string[]).includes(v);

/** Modules that directly depend on `id`. */
export const dependentsOf = (id: ModuleId): ModuleId[] =>
  MODULES.filter((m) => m.dependsOn.includes(id)).map((m) => m.id);

/** `id` plus everything it needs, transitively. */
export function dependencyClosure(id: ModuleId): ModuleId[] {
  const seen = new Set<ModuleId>();
  const visit = (m: ModuleId) => {
    if (seen.has(m)) return;
    seen.add(m);
    MODULE_BY_ID[m].dependsOn.forEach(visit);
  };
  visit(id);
  return [...seen];
}

/** `id` plus everything that (transitively) needs it. */
export function dependentClosure(id: ModuleId): ModuleId[] {
  const seen = new Set<ModuleId>();
  const visit = (m: ModuleId) => {
    if (seen.has(m)) return;
    seen.add(m);
    dependentsOf(m).forEach(visit);
  };
  visit(id);
  return [...seen];
}

/** Defensive: the static registry must be acyclic and reference only known modules. */
export function validateRegistry(modules: readonly ModuleDef[] = MODULES): string[] {
  const problems: string[] = [];
  const ids = new Set(modules.map((m) => m.id));
  if (ids.size !== modules.length) problems.push('duplicate module id');
  for (const m of modules) {
    for (const d of m.dependsOn) if (!ids.has(d)) problems.push(`${m.id} depends on unknown ${d}`);
    if (m.dependsOn.includes(m.id)) problems.push(`${m.id} depends on itself`);
  }
  const state = new Map<ModuleId, 1 | 2>();
  const byId = new Map(modules.map((m) => [m.id, m]));
  const walk = (id: ModuleId, path: ModuleId[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      problems.push(`dependency cycle: ${[...path, id].join(' → ')}`);
      return;
    }
    state.set(id, 1);
    byId.get(id)?.dependsOn.forEach((d) => walk(d, [...path, id]));
    state.set(id, 2);
  };
  modules.forEach((m) => walk(m.id, []));
  return problems;
}
