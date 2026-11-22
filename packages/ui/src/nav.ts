/**
 * ONE navigation list (RESPONSIVE-WEB / NAVIGATION knowledge): the sidebar, rail, bottom bar, "More" sheet and the
 * role-home cards are all built from `NAV_ITEMS`. Add a page in this file and it appears everywhere.
 *
 * Gating: an item whose module is off for the store stays visible but grey and not clickable
 * (feature-flag knowledge: nobody wonders where a menu went). Role order lives in `ROLE_LAYOUT`.
 */
import { isEnabled } from '@bestie/core';
import type {
  DeviceModuleConfig,
  ModuleId,
  RoleModuleConfig,
  StoreModuleConfig,
} from '@bestie/core';
import type { Dict } from '@bestie/i18n';

export type NavLabelKey = Extract<keyof Dict, `nav${string}`>;
export type NavHintKey = Extract<keyof Dict, `hint${string}`>;

export const APP_ROLES = [
  'cashier',
  'waiter',
  'kitchen',
  'manager',
  'owner',
  'platformAdmin',
  'guest',
] as const;
export type AppRole = (typeof APP_ROLES)[number];
export type RoleLabelKey = `role${Capitalize<AppRole>}` & keyof Dict;
export const roleLabelKey = (r: AppRole): RoleLabelKey =>
  `role${r[0]!.toUpperCase()}${r.slice(1)}` as RoleLabelKey;

export const ART_IDS = [
  'sell',
  'tables',
  'queue',
  'orders',
  'customers',
  'shift',
  'receipts',
  'takeOrder',
  'ready',
  'kitchen',
  'menu',
  'stock',
  'staff',
  'reports',
  'credit',
  'points',
  'modules',
  'devices',
  'dashboard',
  'ai',
  'branding',
  'flags',
  'audit',
  'line',
  'analytics',
  'platformAdmins',
  'orgMembers',
  'guestMenu',
  'pass',
  'book',
  'calendar',
  'karaoke',
  'translate',
  'folio',
  'pay',
  'waitlist',
  'timeclock',
  'tours',
  'stamps',
  'marketing',
  'hub',
  'home',
  'account',
  'billing',
] as const;
export type ArtId = (typeof ART_IDS)[number];

export type NavItem = {
  id: ArtId; // one id for nav item + illustration + icon
  path: string;
  label: NavLabelKey;
  hint?: NavHintKey;
  /** Item is usable only if at least one of these modules is enabled. Empty/absent = always. */
  anyModule?: readonly ModuleId[];
};

const item = (
  id: ArtId,
  path: string,
  label: NavLabelKey,
  hint?: NavHintKey,
  anyModule?: readonly ModuleId[],
): NavItem => ({
  id,
  path,
  label,
  hint,
  anyModule,
});

export const NAV_ITEMS: readonly NavItem[] = [
  item('home', '/', 'navHome'),
  item('account', '/account', 'navAccount'),
  item('billing', '/settings/billing', 'navBilling', 'hintBilling'),
  item('sell', '/sell', 'navSell', 'hintSell'),
  item('tables', '/tables', 'navTables', 'hintTables', ['tables.floorplan']),
  item('queue', '/queue', 'navQueue', 'hintQueue', ['queue.call']),
  item('orders', '/orders', 'navOrders', 'hintOrders'),
  item('customers', '/customers', 'navCustomers', 'hintCustomers', ['loyalty.network']),
  item('shift', '/shift', 'navShift', 'hintShift'),
  item('receipts', '/receipts', 'navReceipts', 'hintReceipts'),
  item('takeOrder', '/take-order', 'navTakeOrder', 'hintTakeOrder'),
  item('ready', '/ready', 'navReady', 'hintReady', ['kds']),
  item('kitchen', '/kds', 'navKitchen', 'hintKitchen', ['kds']),
  item('menu', '/menu', 'navMenu', 'hintMenu'),
  item('stock', '/stock', 'navStock', 'hintStock', ['stock']),
  item('staff', '/staff', 'navStaff', 'hintStaff'),
  item('reports', '/reports', 'navReports', 'hintReports'),
  item('credit', '/credit', 'navCredit', 'hintCredit', ['tender.credit']),
  item('points', '/points', 'navPoints', 'hintPoints', ['tender.points']),
  item('modules', '/modules', 'navModules', 'hintModules'),
  item('devices', '/devices', 'navDevices', 'hintDevices'),
  item('dashboard', '/dashboard', 'navDashboard', 'hintDashboard'),
  item('ai', '/ai', 'navAi', 'hintAi', ['ai.assistant']),
  item('branding', '/admin/branding', 'navBranding', 'hintBranding'),
  item('flags', '/admin/flags', 'navFlags', 'hintFlags'),
  item('audit', '/admin/audit', 'navAudit', 'hintAudit'),
  item('line', '/admin/line', 'navLine', 'hintLine'),
  item('analytics', '/admin/analytics', 'navAnalytics', 'hintAnalytics'),
  item('platformAdmins', '/admin/platform-admins', 'navPlatformAdmins', 'hintPlatformAdmins'),
  item('orgMembers', '/admin/org-members', 'navOrgMembers', 'hintOrgMembers'),
  item('guestMenu', '/g/menu', 'navGuestMenu', 'hintGuestMenu'),
  item('pass', '/g/pass', 'navPass', 'hintPass', ['loyalty.network']),
  item('book', '/g/book', 'navBook', 'hintBook', ['appointments']),
  item('calendar', '/calendar', 'navCalendar', 'hintCalendar', ['appointments']),
  item('karaoke', '/karaoke', 'navKaraoke', 'hintKaraoke', ['karaoke.rooms']),
  item('translate', '/translate', 'navTranslate', 'hintTranslate', ['ai.translate']),
  item('folio', '/folio', 'navFolio', 'hintFolio', ['folio']),
  item('pay', '/g/pay', 'navPay', 'hintPay', ['tender.promptpay']),
  item('waitlist', '/waitlist', 'navWaitlist', 'hintWaitlist', ['waitlist']),
  item('timeclock', '/timeclock', 'navTimeclock', 'hintTimeclock', ['timeclock']),
  item('tours', '/tours', 'navTours', 'hintTours', ['slots.booking']),
  item('stamps', '/stamps', 'navStamps', 'hintStamps', ['stamps']),
  item('marketing', '/marketing', 'navMarketing', 'hintMarketing', ['marketing']),
  item('hub', '/integrations', 'navHub', 'hintHub'),
];

export const NAV_BY_ID: Readonly<Record<ArtId, NavItem>> = Object.fromEntries(
  NAV_ITEMS.map((n) => [n.id, n]),
) as Record<ArtId, NavItem>;

export type RoleLayout = {
  /** Cards on the role home, in order. */
  cards: readonly ArtId[];
  /** Raised centre action of the bottom bar (the role's main job). */
  center?: ArtId;
  /** Bottom-bar tabs: first two left of the centre action, last one right of it; "More" is always the 5th slot. */
  tabs: readonly [ArtId, ArtId, ArtId];
};

/** See docs/UX-DESIGN.md §7. Order = importance for that role. */
export const ROLE_LAYOUT: Readonly<Record<AppRole, RoleLayout>> = {
  cashier: {
    center: 'sell',
    tabs: ['home', 'orders', 'tables'],
    cards: [
      'sell',
      'tables',
      'queue',
      'orders',
      'customers',
      'shift',
      'receipts',
      'calendar',
      'waitlist',
      'tours',
      'karaoke',
      'folio',
      'translate',
      'timeclock',
    ],
  },
  waiter: {
    center: 'takeOrder',
    tabs: ['home', 'tables', 'ready'],
    cards: [
      'takeOrder',
      'tables',
      'ready',
      'customers',
      'calendar',
      'waitlist',
      'translate',
      'timeclock',
    ],
  },
  kitchen: { tabs: ['home', 'kitchen', 'ready'], cards: ['kitchen', 'timeclock'] },
  manager: {
    center: 'sell',
    tabs: ['home', 'orders', 'reports'],
    cards: [
      'reports',
      'sell',
      'tables',
      'queue',
      'customers',
      'shift',
      'receipts',
      'calendar',
      'waitlist',
      'tours',
      'karaoke',
      'folio',
      'menu',
      'stock',
      'stamps',
      'marketing',
      'staff',
      'timeclock',
      'translate',
      'credit',
      'points',
      'audit',
    ],
  },
  owner: {
    center: 'dashboard',
    tabs: ['home', 'reports', 'menu'],
    cards: [
      'dashboard',
      'reports',
      'modules',
      'menu',
      'staff',
      'devices',
      'sell',
      'orders',
      'tables',
      'queue',
      'customers',
      'shift',
      'receipts',
      'calendar',
      'waitlist',
      'tours',
      'karaoke',
      'folio',
      'stock',
      'stamps',
      'marketing',
      'timeclock',
      'translate',
      'credit',
      'points',
      'ai',
      'hub',
      'billing',
      'audit',
    ],
  },
  platformAdmin: {
    tabs: ['home', 'branding', 'flags'],
    cards: ['branding', 'flags', 'ai', 'line', 'analytics', 'platformAdmins', 'orgMembers'],
  },
  guest: {
    center: 'guestMenu',
    tabs: ['home', 'pass', 'book'],
    cards: ['guestMenu', 'pass', 'book', 'pay'],
  },
};

// Cards whose illustration should span the full row on a phone.
export const WIDE_CARDS: ReadonlySet<ArtId> = new Set([
  'sell',
  'takeOrder',
  'kitchen',
  'dashboard',
  'branding',
  'guestMenu',
]);

export type NavContext = {
  store: StoreModuleConfig;
  device?: DeviceModuleConfig;
  role?: RoleModuleConfig;
};

/** Is this nav item usable right now? Items without module requirements always are. */
export function navItemEnabled(navItem: NavItem, ctx: NavContext): boolean {
  if (!navItem.anyModule || navItem.anyModule.length === 0) return true;
  return navItem.anyModule.some((m) => isEnabled(ctx.store, m, ctx.device, ctx.role));
}

/** Ids that must be shown grey and not clickable. */
export const disabledNavIds = (
  ctx: NavContext,
  items: readonly NavItem[] = NAV_ITEMS,
): Set<ArtId> => new Set(items.filter((n) => !navItemEnabled(n, ctx)).map((n) => n.id));

/** The item a path belongs to: the longest matching `path` wins ("/admin/audit/settings" → audit). */
export function activeNavId(
  pathname: string,
  items: readonly NavItem[] = NAV_ITEMS,
): ArtId | undefined {
  let best: NavItem | undefined;
  for (const n of items) {
    const match =
      n.path === '/' ? pathname === '/' : pathname === n.path || pathname.startsWith(`${n.path}/`);
    if (match && (!best || n.path.length > best.path.length)) best = n;
  }
  return best?.id;
}

/** The platform administrator's pages, reachable from any app: they are not tied to a shop or to its modules. */
export const PLATFORM_CARDS: readonly ArtId[] = [
  'branding',
  'flags',
  'ai',
  'line',
  'analytics',
  'platformAdmins',
  'orgMembers',
];

/** The cards of a role; a platform administrator also gets the platform pages next to the ones of their shop role. */
export function layoutFor(role: AppRole, platformAdmin = false): RoleLayout {
  const base = ROLE_LAYOUT[role];
  if (!platformAdmin) return base;
  return { ...base, cards: [...new Set<ArtId>([...base.cards, ...PLATFORM_CARDS])] };
}

/** Items shown in the "More" sheet = everything the role can reach that is not already a tab / the centre action. */
export function moreItems(role: AppRole, platformAdmin = false): ArtId[] {
  const layout = layoutFor(role, platformAdmin);
  const shown = new Set<ArtId>([...layout.tabs, ...(layout.center ? [layout.center] : [])]);
  return layout.cards.filter((id) => !shown.has(id));
}

/** Platform pages are never greyed out by a shop's module switches (the AI provider page has nothing to do with one shop's modules). */
export function ungatePlatform(disabled: Set<ArtId>, platformAdmin: boolean): Set<ArtId> {
  if (platformAdmin) for (const id of PLATFORM_CARDS) disabled.delete(id);
  return disabled;
}
