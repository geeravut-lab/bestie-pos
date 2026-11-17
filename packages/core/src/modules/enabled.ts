import { MODULES, MODULE_BY_ID, PLAN_RANK, dependencyClosure, dependentClosure } from './registry';
import type { ModuleId, PlanTier } from './registry';
import type { BusinessProfile } from '../profiles';

export type LegalSignOff = { cryptoTopup: boolean };

/** Per-store module configuration. `overrides` stores explicit choices only; absent = profile default. */
export type StoreModuleConfig = {
  profile: BusinessProfile;
  plan: PlanTier;
  moduleOverrides: Readonly<Partial<Record<ModuleId, boolean>>>;
  /** Copied from the org record by the loader — the registry never trusts the UI for this. */
  legalSignOff: LegalSignOff;
};

/** Device level: a bar tablet may show only some modules. `undefined` = no restriction. */
export type DeviceModuleConfig = { moduleAllowList?: readonly ModuleId[] };

/** Role level: modules hidden for a role (price changes etc. are permissions, not modules). */
export type RoleModuleConfig = { hiddenModules?: readonly ModuleId[] };

export function profileDefault(profile: BusinessProfile, id: ModuleId): boolean {
  return MODULE_BY_ID[id].defaultProfiles.includes(profile);
}

/** Explicit override, else the profile default. Ignores dependencies, plan and legal gates. */
export function chosenOn(store: StoreModuleConfig, id: ModuleId): boolean {
  return store.moduleOverrides[id] ?? profileDefault(store.profile, id);
}

export function planAllows(plan: PlanTier, id: ModuleId): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[MODULE_BY_ID[id].plan];
}

export function legalAllows(legal: LegalSignOff, id: ModuleId): boolean {
  const gate = MODULE_BY_ID[id].legalGate;
  return gate ? legal[gate] === true : true;
}

/** Store-level truth: chosen on, plan covers it, legal gate passed, and every dependency is on too. */
export function isEnabledForStore(store: StoreModuleConfig, id: ModuleId): boolean {
  return dependencyClosure(id).every(
    (m) => chosenOn(store, m) && planAllows(store.plan, m) && legalAllows(store.legalSignOff, m),
  );
}

/**
 * THE check. UI and API both call this (CLAUDE.md rule 6): store → device → role.
 * Hiding a button is not enough — functions call it too.
 */
export function isEnabled(
  store: StoreModuleConfig,
  id: ModuleId,
  device?: DeviceModuleConfig,
  role?: RoleModuleConfig,
): boolean {
  if (!isEnabledForStore(store, id)) return false;
  if (device?.moduleAllowList && !device.moduleAllowList.includes(id)) return false;
  if (role?.hiddenModules?.includes(id)) return false;
  return true;
}

export const enabledModules = (
  store: StoreModuleConfig,
  device?: DeviceModuleConfig,
  role?: RoleModuleConfig,
): ModuleId[] => MODULES.filter((m) => isEnabled(store, m.id, device, role)).map((m) => m.id);

export type ToggleResult =
  | {
      ok: true;
      overrides: Partial<Record<ModuleId, boolean>>;
      autoEnabled: ModuleId[];
      autoDisabled: ModuleId[];
    }
  | { ok: false; reason: 'plan' | 'legal'; module: ModuleId };

/**
 * Toggle screen logic. Enabling auto-enables dependencies; disabling auto-disables dependents
 * (the UI shows `autoDisabled` as a warning before confirming). Disabling hides UI but never deletes data.
 */
export function toggleModule(store: StoreModuleConfig, id: ModuleId, on: boolean): ToggleResult {
  const overrides: Partial<Record<ModuleId, boolean>> = { ...store.moduleOverrides };
  const autoEnabled: ModuleId[] = [];
  const autoDisabled: ModuleId[] = [];

  if (on) {
    for (const m of dependencyClosure(id)) {
      if (!planAllows(store.plan, m)) return { ok: false, reason: 'plan', module: m };
      if (!legalAllows(store.legalSignOff, m)) return { ok: false, reason: 'legal', module: m };
    }
    for (const m of dependencyClosure(id)) {
      if (!chosenOn(store, m) && m !== id) autoEnabled.push(m);
      overrides[m] = true;
    }
  } else {
    for (const m of dependentClosure(id)) {
      if (chosenOn(store, m) && m !== id) autoDisabled.push(m);
      overrides[m] = false;
    }
  }
  return { ok: true, overrides, autoEnabled, autoDisabled };
}

/** Modules a profile switches on out of the box (before any owner override). */
export const defaultModulesFor = (profile: BusinessProfile): ModuleId[] =>
  MODULES.filter((m) => profileDefault(profile, m.id)).map((m) => m.id);

/** Store the owner's decisions compactly: only what differs from the profile default (feature-flag rule). */
export function normalizeOverrides(
  profile: BusinessProfile,
  raw: Readonly<Partial<Record<ModuleId, boolean>>>,
): Partial<Record<ModuleId, boolean>> {
  const out: Partial<Record<ModuleId, boolean>> = {};
  for (const m of MODULES) {
    const v = raw[m.id];
    if (typeof v === 'boolean' && v !== profileDefault(profile, m.id)) out[m.id] = v;
  }
  return out;
}
