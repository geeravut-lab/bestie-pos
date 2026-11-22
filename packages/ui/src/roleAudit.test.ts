import { describe, expect, it } from 'vitest';
import { APP_ROLES, NAV_BY_ID, NAV_ITEMS, ROLE_LAYOUT } from './nav';
import type { AppRole, ArtId } from './nav';

/**
 * AUDIT of "who is shown what". Every card / tab a role sees must open a page that role is ALLOWED to use, and every page a person of that role needs
 * for their job must be reachable from their home. The permissions of the built-in roles mirror the database (foundation migration + later additions);
 * what each page needs is what that page checks. When you add a page, add it here — a failing line is a card pointing at a page the person cannot use.
 */
const BUILT_IN: Record<
  'owner' | 'manager' | 'cashier' | 'waiter' | 'kitchen',
  readonly string[] | 'all'
> = {
  owner: 'all',
  manager: [
    'order.create',
    'order.void',
    'order.discount',
    'refund.create',
    'payment.take',
    'shift.open_close',
    'menu.edit',
    'staff.manage',
    'report.view',
    'customer.view',
    'audit.view',
    'drawer.open',
    'stock.manage',
    'stock.view',
  ],
  cashier: ['order.create', 'payment.take', 'shift.open_close', 'customer.view', 'drawer.open'],
  waiter: ['order.create', 'customer.view'],
  kitchen: ['kds.use'],
};
/** What a page checks before it shows its content ([] = any signed-in member of the shop; 'owner' = the owner only). */
const NEEDS: Partial<Record<ArtId, readonly string[] | 'owner'>> = {
  sell: ['order.create'],
  takeOrder: ['order.create'],
  tables: ['order.create'],
  queue: ['order.create'],
  orders: ['order.create'],
  customers: ['customer.view'],
  shift: ['shift.open_close'],
  receipts: [],
  ready: [],
  kitchen: ['kds.use'],
  calendar: ['order.create'],
  waitlist: ['order.create'],
  tours: ['order.create'],
  karaoke: ['order.create'],
  folio: ['order.create'],
  translate: ['order.create'],
  timeclock: [],
  menu: ['menu.edit'],
  stock: ['stock.view'],
  stamps: ['menu.edit'],
  marketing: ['menu.edit'],
  staff: ['staff.manage'],
  reports: ['report.view'],
  credit: ['report.view'],
  points: ['customer.view'],
  dashboard: ['report.view'],
  ai: ['report.view'],
  audit: ['audit.view'],
  modules: 'owner',
  devices: 'owner',
  billing: 'owner',
  hub: 'owner',
};
const PLATFORM: readonly ArtId[] = [
  'branding',
  'flags',
  'ai',
  'line',
  'analytics',
  'platformAdmins',
];
const GUEST: readonly ArtId[] = ['guestMenu', 'pass', 'book', 'pay'];

const may = (role: AppRole, need: readonly string[] | 'owner'): boolean => {
  if (role === 'owner') return true;
  if (need === 'owner') return false;
  if (role === 'platformAdmin' || role === 'guest') return true; // judged by their own rules below
  const perms = BUILT_IN[role];
  return need.every((n) => perms !== 'all' && perms.includes(n));
};

describe('role audit: no card points at a page the role cannot use', () => {
  for (const role of APP_ROLES) {
    it(`${role}: every card, tab and centre action is usable by that role`, () => {
      const l = ROLE_LAYOUT[role];
      const ids = [...new Set<ArtId>([...l.cards, ...l.tabs, ...(l.center ? [l.center] : [])])];
      for (const id of ids) {
        if (id === 'home') continue;
        if (role === 'guest') {
          expect(GUEST, `${role}:${id} must be a guest page`).toContain(id);
          continue;
        }
        if (role === 'platformAdmin') {
          expect(PLATFORM, `${role}:${id} must be a platform page`).toContain(id);
          continue;
        }
        expect(
          Object.keys(NEEDS),
          `${role}:${id} has no entry in NEEDS (add what the page checks)`,
        ).toContain(id);
        expect(
          may(role, NEEDS[id]!),
          `${role} is shown "${id}" but its page needs ${JSON.stringify(NEEDS[id])}`,
        ).toBe(true);
      }
    });
  }

  it('every nav item is either audited here, a platform page, a guest page, or the shell itself', () => {
    for (const n of NAV_ITEMS) {
      if (['home', 'account'].includes(n.id)) continue;
      expect(
        [...Object.keys(NEEDS), ...PLATFORM, ...GUEST],
        `nav item "${n.id}" is not covered by the role audit`,
      ).toContain(n.id);
    }
  });
});

describe('role audit: a person can reach what their job needs', () => {
  const reach = (role: AppRole): ArtId[] => {
    const l = ROLE_LAYOUT[role];
    return [...l.cards, ...l.tabs, ...(l.center ? [l.center] : [])];
  };
  it('front desk (cashier) reaches selling, bookings, the waiting list, tours, the drawer and the time clock', () => {
    for (const id of [
      'sell',
      'orders',
      'tables',
      'shift',
      'receipts',
      'customers',
      'calendar',
      'waitlist',
      'tours',
      'timeclock',
    ] as ArtId[])
      expect(reach('cashier'), `cashier needs ${id}`).toContain(id);
  });
  it('waiters take orders, see the waiting list and the calendar, and clock in', () => {
    for (const id of ['takeOrder', 'tables', 'waitlist', 'calendar', 'timeclock'] as ArtId[])
      expect(reach('waiter')).toContain(id);
  });
  it('the kitchen screen can clock in too', () => {
    expect(reach('kitchen')).toContain('timeclock');
  });
  it('managers reach everything the owner uses to run the floor and the shop, except owner-only settings', () => {
    for (const id of [
      'sell',
      'orders',
      'tables',
      'queue',
      'customers',
      'shift',
      'calendar',
      'waitlist',
      'tours',
      'stamps',
      'marketing',
      'menu',
      'stock',
      'staff',
      'timeclock',
      'reports',
      'credit',
      'points',
    ] as ArtId[])
      expect(reach('manager'), `manager needs ${id}`).toContain(id);
    for (const id of ['modules', 'devices', 'billing', 'hub'] as ArtId[])
      expect(reach('manager')).not.toContain(id);
  });
  it('the owner reaches every shop page, the settings and the hub', () => {
    for (const id of Object.keys(NEEDS) as ArtId[])
      if (id !== 'kitchen' && id !== 'ready' && id !== 'takeOrder')
        expect(reach('owner'), `owner needs ${id}`).toContain(id);
  });
  it('every nav page has an owner of some kind (a card on at least one role home)', () => {
    const shown = new Set(APP_ROLES.flatMap((r) => reach(r)));
    for (const n of NAV_ITEMS)
      if (!['home', 'account'].includes(n.id))
        expect(shown, `no role is shown "${n.id}"`).toContain(n.id);
    expect(NAV_BY_ID.hub.path).toBe('/integrations');
  });
});
