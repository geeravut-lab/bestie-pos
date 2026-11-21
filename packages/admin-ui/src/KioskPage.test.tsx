import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { KioskPage } from './KioskPage';

afterEach(cleanup);
const liveDb = (...args: Parameters<typeof fakeDb>) => {
  const db = fakeDb(...args);
  Object.assign(db.client as object, {
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  });
  return db;
};
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/kiosk',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const kiosks = [
  { id: 'k1', name: 'Front kiosk', qr_token: 'a'.repeat(32), active: true },
  { id: 'k2', name: 'Side kiosk', qr_token: 'b'.repeat(32), active: false },
];

describe('<KioskPage>', () => {
  it('lists the kiosks with their links', async () => {
    const db = liveDb({ dining_tables: kiosks });
    wrap(<KioskPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('Front kiosk')).toBeTruthy();
    const links = screen.getAllByLabelText('The kiosk link') as HTMLInputElement[];
    expect(links[0]!.value.endsWith(`/t/${'a'.repeat(32)}`)).toBe(true);
    expect(screen.getByText('Switched off')).toBeTruthy();
  });
  it('adds a kiosk by name', async () => {
    const db = liveDb({ dining_tables: [] });
    wrap(<KioskPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('No kiosks yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a kiosk' }));
    const form = screen.getByRole('form', { name: 'Add a kiosk' });
    await userEvent.type(within(form).getByLabelText(/Name of the kiosk/), 'Door kiosk');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.rpcs.length).toBe(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'save_kiosk',
      args: { p: { store_id: 's1', name: 'Door kiosk' } },
    });
  });
  it('makes a new link and switches a kiosk off', async () => {
    const db = liveDb({ dining_tables: kiosks });
    wrap(<KioskPage ctx={ctx(db.client)} />);
    const row = (await screen.findByText('Front kiosk')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: /Make a new link/ }));
    await waitFor(() => expect(db.rpcs.length).toBe(1));
    expect(db.rpcs[0]!.args).toEqual({ p: { store_id: 's1', id: 'k1', rotate: true } });
    await userEvent.click(within(row).getByRole('button', { name: 'Switch this kiosk off' }));
    await waitFor(() => expect(db.rpcs.length).toBe(2));
    expect(db.rpcs[1]!.args).toEqual({ p: { store_id: 's1', id: 'k1', active: false } });
  });
  it('shows a clear message for a name that is taken, and nothing to edit for a cashier', async () => {
    const db = liveDb(
      { dining_tables: kiosks },
      { rpc: { save_kiosk: { error: { code: '23505' } } } },
    );
    wrap(<KioskPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a kiosk' }));
    await userEvent.type(screen.getByLabelText(/Name of the kiosk/), 'Front kiosk');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/not used by another table or kiosk/)).toBeTruthy();
    cleanup();
    const d2 = liveDb({ dining_tables: kiosks });
    wrap(<KioskPage ctx={ctx(d2.client, { isOwner: false, permissions: ['order.create'] })} />);
    await screen.findByText('Front kiosk');
    expect(screen.queryByRole('button', { name: 'Add a kiosk' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Make a new link/ })).toBeNull();
  });
  it('says the module is off', async () => {
    const db = liveDb({ dining_tables: [] });
    wrap(<KioskPage ctx={ctx(db.client, { isModuleOn: () => false })} />);
    expect(await screen.findByText(/is off in this shop/)).toBeTruthy();
  });
});
