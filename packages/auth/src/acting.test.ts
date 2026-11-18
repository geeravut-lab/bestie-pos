import { describe, expect, it } from 'vitest';
import { effectiveActing, withActing } from './acting';
import type { ActingIdentity } from './acting';
import type { Membership } from './myContext';

const acting: ActingIdentity = {
  staffId: 'nok',
  accountId: 'u1',
  displayName: 'Nok',
  roleName: 'Cashier',
  roleBuiltIn: 'cashier',
  permissions: ['payment.take'],
  hiddenModules: ['kiosk'],
};
const account: Membership = {
  staffId: 'tablet',
  orgId: 'o1',
  orgName: 'Acme',
  storeId: 's1',
  displayName: 'Tablet account',
  roleBuiltIn: 'manager',
  roleName: 'Manager',
  permissions: ['staff.manage', 'menu.edit', 'payment.take'],
  hiddenModules: [],
  legalSignOff: { cryptoTopup: false },
};

describe('acting identity', () => {
  it('counts only for the account that unlocked', () => {
    expect(effectiveActing(acting, 'u1')).toBe(acting);
    expect(effectiveActing(acting, 'someone-else')).toBeNull();
    expect(effectiveActing(acting, undefined)).toBeNull();
    expect(effectiveActing(null, 'u1')).toBeNull();
  });
  it("the acting person's role replaces the account's role — they never get MORE than their own permissions", () => {
    const m = withActing(account, acting)!;
    expect(m.permissions).toEqual(['payment.take']);
    expect(m.roleBuiltIn).toBe('cashier');
    expect(m.hiddenModules).toEqual(['kiosk']);
    expect(m.orgId).toBe('o1'); // still the same shop
    expect(m.legalSignOff).toEqual({ cryptoTopup: false });
  });
  it('without an acting person the account is used as it is', () => {
    expect(withActing(account, null)).toBe(account);
    expect(withActing(undefined, acting)).toBeUndefined();
  });
});
