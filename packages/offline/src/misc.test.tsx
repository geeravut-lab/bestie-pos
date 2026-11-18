import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import {
  SyncIndicator,
  cacheGet,
  cachePut,
  cachedRead,
  getDeviceBinding,
  resetOfflineDb,
  setDeviceBinding,
} from './index';

afterEach(cleanup);
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});

describe('cache', () => {
  it('network first: fresh data is returned and remembered', async () => {
    const r = await cachedRead('menu:s1', async () => ['fresh']);
    expect(r).toEqual({ data: ['fresh'], stale: false });
    expect((await cacheGet<string[]>('menu:s1'))?.data).toEqual(['fresh']);
  });
  it('when the network fails the last saved copy is returned and marked stale', async () => {
    await cachePut('menu:s1', ['saved']);
    const r = await cachedRead('menu:s1', async () => {
      throw new Error('offline');
    });
    expect(r).toEqual({ data: ['saved'], stale: true });
  });
  it('no network and no copy: the error reaches the caller', async () => {
    await expect(
      cachedRead('nothing', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
  });
});

describe('device binding', () => {
  const binding = {
    deviceId: 'd1',
    storeId: 's1',
    orgId: 'o1',
    name: 'Counter',
    role: 'cashier' as const,
    station: null,
    posId: 'POS-1',
  };
  it('round-trips and can be cleared', () => {
    expect(getDeviceBinding()).toBeNull();
    setDeviceBinding(binding);
    expect(getDeviceBinding()).toEqual(binding);
    setDeviceBinding(null);
    expect(getDeviceBinding()).toBeNull();
  });
  it('ignores a damaged or tampered value instead of crashing', () => {
    localStorage.setItem('bestie-device', '{"deviceId":1}');
    expect(getDeviceBinding()).toBeNull();
    localStorage.setItem('bestie-device', 'not json');
    expect(getDeviceBinding()).toBeNull();
  });
});

describe('<SyncIndicator>', () => {
  const mount = (p: Parameters<typeof SyncIndicator>[0]) =>
    render(
      <I18nProvider initialLang="en">
        <SyncIndicator {...p} />
      </I18nProvider>,
    );
  it('says when the tablet is offline and how many writes wait', () => {
    mount({ state: 'offline', pending: 3, dead: 0 });
    expect(screen.getByRole('status').textContent).toContain('Offline · 3 waiting to send');
  });
  it('says everything is synced', () => {
    mount({ state: 'synced', pending: 0, dead: 0 });
    expect(screen.getByRole('status').textContent).toContain('All synced');
  });
  it('flags writes that need attention, with a send-now button when it can help', () => {
    mount({ state: 'attention', pending: 0, dead: 2, onSyncNow: async () => {} });
    expect(screen.getByRole('status').textContent).toContain('2 could not be sent');
    expect(screen.getByRole('button', { name: 'Send now' })).toBeTruthy();
  });
});
