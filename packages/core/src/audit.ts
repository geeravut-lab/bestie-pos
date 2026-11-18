/**
 * Audit trail event catalogue (docs/AUDIT-TRAIL-KNOWLEDGE.md). The database seeds the same list
 * (`audit_event_types` in the audit migration) — a unit test keeps the two in sync.
 *
 * `critical` events are ALWAYS recorded: money, roles, legal sign-off, module switches, the audit settings themselves and
 * audit exports. An admin may switch auditing off or untick ordinary events, never these — switching them off would hide
 * fraud and break tax / AML evidence.
 */
export const AUDIT_GROUPS = [
  'auth',
  'staff',
  'menu',
  'order',
  'payment',
  'credit',
  'points',
  'shift',
  'device',
  'settings',
  'export',
] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];

export type AuditEventDef = { id: string; group: AuditGroup; critical: boolean };

const ev = (id: string, group: AuditGroup, critical = false): AuditEventDef => ({
  id,
  group,
  critical,
});

export const AUDIT_EVENTS = [
  ev('auth.login', 'auth'),
  ev('auth.login_failed', 'auth'),
  ev('auth.password_change', 'auth', true),
  ev('auth.pin_lockout', 'auth'),
  ev('staff.add', 'staff'),
  ev('staff.role_change', 'staff', true),
  ev('staff.deactivate', 'staff', true),
  ev('menu.item_change', 'menu'),
  ev('menu.price_change', 'menu'),
  ev('order.void', 'order', true),
  ev('order.discount', 'order'),
  ev('order.price_override', 'order'),
  ev('order.reopen', 'order'),
  ev('payment.refund', 'payment', true),
  ev('payment.tender', 'payment'),
  ev('payment.split', 'payment'),
  ev('credit.topup', 'credit', true),
  ev('credit.spend', 'credit', true),
  ev('credit.adjust', 'credit', true),
  ev('points.redeem', 'points'),
  ev('points.adjust', 'points', true),
  ev('shift.open', 'shift'),
  ev('shift.close', 'shift'),
  ev('shift.cash_variance', 'shift'),
  ev('device.register', 'device'),
  ev('device.pos_id_change', 'device', true),
  ev('module.toggle', 'settings', true),
  ev('org.legal_signoff_change', 'settings', true),
  ev('settings.change', 'settings'),
  ev('brand.change', 'settings'),
  ev('ai.settings_change', 'settings'),
  ev('ai.prompt_change', 'settings'),
  ev('audit.settings_change', 'settings', true),
  ev('export.audit', 'export', true),
  ev('export.report', 'export'),
] as const satisfies readonly AuditEventDef[];

export type AuditEventId = (typeof AUDIT_EVENTS)[number]['id'];

const BY_ID: ReadonlyMap<string, AuditEventDef> = new Map(AUDIT_EVENTS.map((e) => [e.id, e]));
export const isAuditEvent = (v: unknown): v is AuditEventId =>
  typeof v === 'string' && BY_ID.has(v);
export const isCriticalAuditEvent = (id: string): boolean => BY_ID.get(id)?.critical === true;

/** i18n key of an event / group label — see packages/i18n (`auditEvt_order_void`, `auditGrp_order`). */
export const auditEventLabelKey = (id: string): string => `auditEvt_${id.replace(/[.]/g, '_')}`;
export const auditGroupLabelKey = (g: AuditGroup): string => `auditGrp_${g}`;

export const eventsInGroup = (g: AuditGroup): readonly AuditEventDef[] =>
  AUDIT_EVENTS.filter((e) => e.group === g);

/** Stored the same way as feature flags: only what is switched OFF. */
export type AuditSettings = { enabled: boolean; disabledEvents: readonly string[] };
export const DEFAULT_AUDIT_SETTINGS: AuditSettings = { enabled: true, disabledEvents: [] };

/** Keep only known, non-critical ids (a bad row must not hide a critical event or break the screen). */
export function normalizeDisabled(raw: unknown): AuditEventId[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(raw.filter((x): x is AuditEventId => isAuditEvent(x) && !isCriticalAuditEvent(x))),
  ].sort();
}

/** Mirror of the database rule (`audit_record`): critical → always; otherwise needs the switch on and the type ticked. */
export function shouldRecord(settings: AuditSettings | undefined, id: string): boolean {
  if (!isAuditEvent(id)) return false;
  if (isCriticalAuditEvent(id)) return true;
  const s = settings ?? DEFAULT_AUDIT_SETTINGS;
  return s.enabled && !s.disabledEvents.includes(id);
}

/** Tick / untick one event type. Critical events cannot be unticked (returns the settings unchanged). */
export function setEventRecorded(
  settings: AuditSettings,
  id: string,
  recorded: boolean,
): AuditSettings {
  if (!isAuditEvent(id) || isCriticalAuditEvent(id)) return settings;
  const rest = settings.disabledEvents.filter((e) => e !== id);
  return { ...settings, disabledEvents: normalizeDisabled(recorded ? rest : [...rest, id]) };
}

/** Tick / untick a whole group (critical events in it are left as they are). */
export function setGroupRecorded(
  settings: AuditSettings,
  g: AuditGroup,
  recorded: boolean,
): AuditSettings {
  return eventsInGroup(g).reduce((acc, e) => setEventRecorded(acc, e.id, recorded), settings);
}

const PII_KEY =
  /(name|e-?mail|phone|tel|address|passw|pin|token|secret|note|message|text|comment|card)/i;

/** Client-side mirror of `audit_clean_detail`: ids, codes, numbers, booleans only. */
export function cleanAuditDetail(
  detail: unknown,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return out;
  for (const [k, v] of Object.entries(detail)) {
    if (PII_KEY.test(k)) continue;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
      continue;
    if (JSON.stringify(v).length > 200) continue;
    out[k] = v;
  }
  return out;
}
