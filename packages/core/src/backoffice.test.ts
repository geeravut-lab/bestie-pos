import { describe, expect, it } from 'vitest';
import {
  deviceProblems,
  formatInviteCode,
  isInviteCodeShape,
  isValidPin,
  isValidPosId,
  isWeakPin,
  moduleRows,
  normalizeInviteCode,
} from './backoffice';
import { MODULE_IDS } from './modules/registry';
import type { StoreModuleConfig } from './modules/enabled';

const store = (over: Partial<StoreModuleConfig> = {}): StoreModuleConfig => ({
  profile: 'restaurant',
  plan: 'pro',
  moduleOverrides: {},
  legalSignOff: { cryptoTopup: false },
  ...over,
});

describe('moduleRows', () => {
  it('has one row per module, in registry order', () => {
    expect(moduleRows(store()).map((r) => r.id)).toEqual([...MODULE_IDS]);
  });

  it('shows what is chosen vs what actually works', () => {
    const rows = Object.fromEntries(
      moduleRows(store({ moduleOverrides: { kds: false } })).map((r) => [r.id, r]),
    );
    expect(rows['kds']).toMatchObject({ chosen: false, effective: false });
    expect(rows['tables.floorplan']).toMatchObject({ chosen: true, effective: true });
  });

  it('locks modules above the plan and the legally gated crypto top-up', () => {
    const rows = Object.fromEntries(moduleRows(store({ plan: 'basic' })).map((r) => [r.id, r]));
    expect(rows['kds']!.locked).toBe('plan');
    expect(rows['credit.topup.crypto']!.locked).not.toBeNull();
    const signed = Object.fromEntries(
      moduleRows(store({ plan: 'pro', legalSignOff: { cryptoTopup: true } })).map((r) => [r.id, r]),
    );
    expect(signed['credit.topup.crypto']!.locked).toBeNull();
    const unsigned = Object.fromEntries(moduleRows(store({ plan: 'pro' })).map((r) => [r.id, r]));
    expect(unsigned['credit.topup.crypto']!.locked).toBe('legal');
  });

  it('lists the chosen modules that switch off together (the warning before confirming)', () => {
    const rows = Object.fromEntries(
      moduleRows(store({ profile: 'salon', moduleOverrides: { deposits: true } })).map((r) => [
        r.id,
        r,
      ]),
    );
    expect(rows['appointments']!.dependents).toContain('deposits');
  });
});

describe('devices', () => {
  const ok = { name: 'Counter', role: 'cashier', station: null, posId: '' } as const;
  it('accepts a plain cashier tablet and a KDS with a station', () => {
    expect(deviceProblems(ok)).toEqual([]);
    expect(deviceProblems({ ...ok, role: 'kds', station: 'bar', posId: 'POS-001' })).toEqual([]);
  });
  it('rejects bad names, stations on non-KDS devices, KDS without station and odd POS IDs', () => {
    expect(deviceProblems({ ...ok, name: '  ' })).toContain('name');
    expect(deviceProblems({ ...ok, station: 'bar' })).toContain('station');
    expect(deviceProblems({ ...ok, role: 'kds' })).toContain('station');
    expect(deviceProblems({ ...ok, posId: 'x; drop' })).toContain('posId');
  });
  it('POS ID rule matches the SQL check', () => {
    expect(isValidPosId('AB-12')).toBe(true);
    expect(isValidPosId('')).toBe(false);
    expect(isValidPosId('a'.repeat(41))).toBe(false);
    expect(isValidPosId('ก')).toBe(false);
  });
});

describe('PIN & invite codes', () => {
  it('PIN is 4–8 digits', () => {
    for (const p of ['1234', '12345678']) expect(isValidPin(p)).toBe(true);
    for (const p of ['123', '123456789', '12a4', ' 123', '١٢٣٤']) expect(isValidPin(p)).toBe(false);
  });
  it('flags obvious PINs as weak', () => {
    for (const p of ['1111', '1234', '4321', '123456', '0000']) expect(isWeakPin(p)).toBe(true);
    for (const p of ['4821', '1357', '2580']) expect(isWeakPin(p)).toBe(false);
  });
  it('invite codes ignore case, spaces and dashes', () => {
    expect(normalizeInviteCode(' ab12-cd34 ef56 ')).toBe('AB12CD34EF56');
    expect(isInviteCodeShape('ab12-cd34-ef56')).toBe(true);
    expect(isInviteCodeShape('xyz')).toBe(false);
    expect(formatInviteCode('AB12CD34EF56')).toBe('AB12-CD34-EF56');
  });
});
