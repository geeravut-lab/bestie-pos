/**
 * Domain types. Conventions (CLAUDE.md):
 *  - every record carries `orgId` and `storeId` (multi-tenant from day one);
 *  - ids are client-generated UUID strings (offline-first: a write can be created before the server sees it);
 *  - money is integer satang (`Satang`); timestamps are ISO-8601 strings in UTC;
 *  - nothing here knows about React, Supabase or Vercel.
 */
import type {
  DeviceModuleConfig,
  LegalSignOff,
  RoleModuleConfig,
  StoreModuleConfig,
} from './modules/enabled';
import type { Satang } from './money';
import type { RoundingConfig, TenderKind } from './rounding';
import type { PriceMode } from './tax';
import type { BusinessProfile } from './profiles';
import type { ModuleId, PlanTier } from './modules/registry';

export type Id = string;
export type IsoDateTime = string;
export type Lang = 'th' | 'en';
export type LocalizedText = { th: string; en?: string } & Partial<Record<string, string>>;

export type Scope = { orgId: Id; storeId: Id };

// ── tenancy ─────────────────────────────────────────────────────────────────
export type Org = {
  id: Id;
  name: string;
  /** Lawyer / regulator gates (CLAUDE.md rule 3). Absent = false. */
  legalSignOff: LegalSignOff;
  createdAt: IsoDateTime;
};

/** A company that can issue Bestie Credit. Credit is only usable inside ONE legal entity (rule 2). */
export type LegalEntity = {
  id: Id;
  orgId: Id;
  name: string;
  /** 13-digit Thai tax id. */
  taxId?: string;
};

export type VatSettings = {
  registered: boolean;
  /** 700 = 7 %. 0 when not registered. */
  vatBps: number;
  /** "00000" = head office; needed for tax invoices (rule 4). */
  branchCode: string;
};

export type Store = Scope &
  StoreModuleConfig & {
    id: Id;
    name: string;
    legalEntityId: Id;
    vat: VatSettings;
    serviceChargeBps: number;
    priceMode: PriceMode;
    rounding: RoundingConfig;
    defaultLang: Lang;
    timezone: string; // IANA, "Asia/Bangkok"
  };

export type DeviceRole = 'cashier' | 'staff' | 'kds';

export type Device = Scope &
  DeviceModuleConfig & {
    id: Id;
    name: string;
    role: DeviceRole;
    /** Revenue Department POS ID — printed on abbreviated tax invoices (rule 4). */
    revenuePosId?: string;
    station?: 'kitchen' | 'bar';
  };

// ── people & permissions ────────────────────────────────────────────────────
export const PERMISSIONS = [
  'order.create',
  'order.void',
  'order.discount',
  'price.override',
  'refund.create',
  'payment.take',
  'shift.open_close',
  'menu.edit',
  'staff.manage',
  'module.toggle',
  'report.view',
  'customer.view',
  'credit.adjust',
  'audit.view',
  'settings.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type Role = RoleModuleConfig & {
  id: Id;
  orgId: Id;
  name: string;
  permissions: readonly Permission[];
};

/** Built-in roles. SSO / login never decides a role — only the org does. */
export type BuiltInRoleKey = 'owner' | 'manager' | 'cashier' | 'waiter' | 'kitchen';

export type Staff = {
  id: Id;
  orgId: Id;
  /** null = works across all stores of the org. */
  storeId: Id | null;
  userId?: Id; // Supabase auth user, if they log in with an account
  displayName: string;
  roleId: Id;
  active: boolean;
};

// ── menu ────────────────────────────────────────────────────────────────────
export type Channel = 'dine-in' | 'takeaway' | 'delivery' | 'qr';
export type ChannelPrices = Partial<Record<Channel, Satang>> & { base: Satang };

export type Modifier = {
  id: Id;
  name: LocalizedText;
  /** Added to the unit price. May be negative (e.g. "no meat"). */
  priceDelta: Satang;
  /** Per-option channel pricing overrides (docs/PRODUCT_SPEC §6). */
  channelDelta?: Partial<Record<Channel, Satang>>;
};

export type ModifierGroup = Scope & {
  id: Id;
  name: LocalizedText;
  /** Min/max number of options the guest must/can choose. */
  min: number;
  max: number;
  options: readonly Modifier[];
};

export type MenuItem = Scope & {
  id: Id;
  categoryId: Id;
  name: LocalizedText;
  prices: ChannelPrices;
  modifierGroupIds: readonly Id[];
  station?: 'kitchen' | 'bar';
  available: boolean;
};

// ── orders & payments ───────────────────────────────────────────────────────
export type OrderStatus = 'open' | 'sent' | 'ready' | 'served' | 'paid' | 'void';

export type OrderLine = {
  id: Id;
  itemId: Id;
  /** Snapshot of the name at order time; menu edits never rewrite history. */
  name: LocalizedText;
  unitPrice: Satang; // already includes modifier deltas
  quantity: number;
  modifiers: readonly { id: Id; name: LocalizedText; priceDelta: Satang }[];
  note?: string;
  discount?: Satang;
};

export type Order = Scope & {
  id: Id;
  /** Human number (queue ticket / bill no.), unique per store per day. */
  number: string;
  channel: Channel;
  status: OrderStatus;
  tableId?: Id;
  customerId?: Id;
  lines: readonly OrderLine[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  createdByStaffId?: Id;
};

export type PaymentStatus = 'pending' | 'confirmed' | 'failed' | 'voided';

export type Payment = Scope & {
  id: Id;
  orderId: Id;
  tender: TenderKind;
  amount: Satang;
  status: PaymentStatus;
  /** PSP / PromptPay reference, never card data. */
  reference?: string;
  createdAt: IsoDateTime;
};

// ── customers ───────────────────────────────────────────────────────────────
export type Customer = Scope & {
  id: Id;
  /** One profile across the network; `storeId` = store where it was first created. */
  phone?: string;
  displayName?: string;
  lang: Lang;
  /** Needed for full tax invoices later (Phase 4) but modelled now (rule 4). */
  taxId?: string;
  branchCode?: string;
};

// ── ledgers ─────────────────────────────────────────────────────────────────
export type { Satang, TenderKind, BusinessProfile, ModuleId, PlanTier, PriceMode };
