import { beforeEach, describe, expect, it } from 'vitest';
import { IDLE_LOCK_MS } from '@bestie/core';
import type { ActingIdentity } from '@bestie/auth';
import { loadActing, saveActing } from './acting';

const nok: ActingIdentity = {
  staffId: 's1',
  accountId: 'u1',
  displayName: 'Nok',
  roleName: 'Cashier',
  roleBuiltIn: 'cashier',
  permissions: ['order.create', 'payment.take'],
  hiddenModules: [],
};

beforeEach(() => sessionStorage.clear());

describe('acting identity', () => {
  it('survives a reload while the till is in use', () => {
    saveActing(nok, 1_000);
    expect(loadActing(1_000 + 60_000)).toEqual(nok);
  });
  it('is gone after the idle time (the PIN is asked again)', () => {
    saveActing(nok, 1_000);
    expect(loadActing(1_000 + IDLE_LOCK_MS)).toBeNull();
  });
  it('clearing it locks the till', () => {
    saveActing(nok, 1_000);
    saveActing(null);
    expect(loadActing(1_001)).toBeNull();
  });
  it('a damaged or hand-edited value never grants anything', () => {
    sessionStorage.setItem('bestie-acting', 'not json');
    expect(loadActing()).toBeNull();
    sessionStorage.setItem(
      'bestie-acting',
      JSON.stringify({ acting: { staffId: 1 }, lastActive: Date.now() }),
    );
    expect(loadActing()).toBeNull();
  });
  it('unknown permissions and role names are dropped when read back', () => {
    sessionStorage.setItem(
      'bestie-acting',
      JSON.stringify({
        lastActive: Date.now(),
        acting: { ...nok, permissions: ['payment.take', 'god.mode'], roleBuiltIn: 'superuser' },
      }),
    );
    const a = loadActing()!;
    expect(a.permissions).toEqual(['payment.take']);
    expect(a.roleBuiltIn).toBeNull();
  });
});
