/**
 * Back-office rules that must be identical in the screens and (by SQL twin) in the database:
 * the module toggle table, device and staff-PIN input rules, invite codes. Pure — no React, no I/O.
 */
import { MODULES, MODULE_IDS, dependencyClosure, dependentClosure } from './modules/registry';
import type { ModuleId, PlanTier } from './modules/registry';
import { chosenOn, isEnabledForStore, legalAllows, planAllows } from './modules/enabled';
import type { StoreModuleConfig } from './modules/enabled';
import type { DeviceRole } from './types';

export type ModuleRow = {
  id: ModuleId;
  plan: PlanTier;
  dependsOn: readonly ModuleId[];
  /** What the owner has chosen (override or profile default). */
  chosen: boolean;
  /** What actually happens: chosen AND plan covers it AND legal gate passed AND dependencies are on. */
  effective: boolean;
  /** The switch cannot be turned on, and why. */
  locked: null | 'plan' | 'legal';
  /** Modules that would be switched off together with this one (shown as a warning before confirming). */
  dependents: readonly ModuleId[];
};

/** Everything the toggle screen needs for one store, in registry order. */
export function moduleRows(store: StoreModuleConfig): ModuleRow[] {
  return MODULES.map((m) => {
    const chain = dependencyClosure(m.id);
    const locked = chain.some((d) => !planAllows(store.plan, d))
      ? ('plan' as const)
      : chain.some((d) => !legalAllows(store.legalSignOff, d))
        ? ('legal' as const)
        : null;
    return {
      id: m.id,
      plan: m.plan,
      dependsOn: m.dependsOn,
      chosen: chosenOn(store, m.id),
      effective: isEnabledForStore(store, m.id),
      locked,
      dependents: dependentClosure(m.id).filter((d) => d !== m.id && chosenOn(store, d)),
    };
  });
}

// ── devices ─────────────────────────────────────────────────────────────────
export const DEVICE_ROLES: readonly DeviceRole[] = ['cashier', 'staff', 'kds'];
export const KDS_STATIONS = ['kitchen', 'bar'] as const;
export type KdsStation = (typeof KDS_STATIONS)[number];

/** Revenue Department POS ID as printed on abbreviated tax invoices: letters, digits and dashes (twin of the SQL check). */
export const isValidPosId = (v: string): boolean => /^[A-Za-z0-9-]{1,40}$/.test(v);

/** A device's role decides its screen; only a KDS has a station (twin of the SQL trigger). */
export const deviceProblems = (d: {
  name: string;
  role: DeviceRole;
  station: KdsStation | null;
  posId: string;
}): ('name' | 'station' | 'posId')[] => {
  const out: ('name' | 'station' | 'posId')[] = [];
  const n = d.name.trim().length;
  if (n < 1 || n > 60) out.push('name');
  if (d.role !== 'kds' && d.station !== null) out.push('station');
  if (d.role === 'kds' && d.station === null) out.push('station');
  if (d.posId.trim() !== '' && !isValidPosId(d.posId.trim())) out.push('posId');
  return out;
};

// ── staff PIN & invites ─────────────────────────────────────────────────────
export const PIN_MIN = 4;
export const PIN_MAX = 8;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;
export const isValidPin = (v: string): boolean => /^[0-9]{4,8}$/.test(v);

/** Obvious PINs that a shop owner should not pick (all the same digit, straight run). Advice, not a database rule. */
export function isWeakPin(v: string): boolean {
  if (!isValidPin(v)) return false;
  if (/^(\d)\1+$/.test(v)) return true;
  const d = [...v].map(Number);
  const step = d[1]! - d[0]!;
  return Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1]! === step);
}

export const INVITE_CODE_LENGTH = 12;
/** What the person typed → the code the server expects (spaces, dashes and case do not matter). */
export const normalizeInviteCode = (v: string): string => v.replace(/[\s-]/g, '').toUpperCase();
export const isInviteCodeShape = (v: string): boolean =>
  new RegExp(`^[0-9A-F]{${INVITE_CODE_LENGTH}}$`).test(normalizeInviteCode(v));
/** Show a code as AAAA-BBBB-CCCC so it is easy to read out loud. */
export const formatInviteCode = (v: string): string =>
  normalizeInviteCode(v)
    .match(/.{1,4}/g)
    ?.join('-') ?? '';

/** Profiles a new shop can pick in Phase 1 (the others arrive with their phase — docs/PHASE1_TASKS.md). */
export const SELECTABLE_PROFILES = ['restaurant', 'cafe', 'salon', 'spa'] as const;

/** Unknown module ids and non-boolean values are dropped (a bad row must never break a screen). */
export function cleanModuleOverrides(raw: unknown): Partial<Record<ModuleId, boolean>> {
  const out: Partial<Record<ModuleId, boolean>> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if ((MODULE_IDS as readonly string[]).includes(k) && typeof v === 'boolean')
        out[k as ModuleId] = v;
    }
  }
  return out;
}

/** A till locks itself after this much idle time (the next person enters their PIN). */
export const IDLE_LOCK_MS = 5 * 60_000;
export const isIdleExpired = (lastActive: number, now: number): boolean =>
  now - lastActive >= IDLE_LOCK_MS;
