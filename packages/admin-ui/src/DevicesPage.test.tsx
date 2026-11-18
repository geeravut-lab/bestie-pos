import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { DevicesPage } from './DevicesPage';
import { fakeDb } from './fakeDb';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const stores = [{ id: 's1', name: 'Acme', vat_registered: true }];
const device = {
  id: 'd1',
  store_id: 's1',
  name: 'Counter iPad',
  role: 'cashier',
  station: null,
  revenue_pos_id: 'POS-001',
  active: true,
};
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/devices',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: null,
  permissions: [],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <DevicesPage ctx={c} />
    </I18nProvider>,
  );

describe('<DevicesPage>', () => {
  it('shows the empty state and lets the owner register the first device', async () => {
    const db = fakeDb({ devices: [], stores });
    mount(ctx(db.client));
    await screen.findByText(/No devices yet/);
    await userEvent.type(screen.getByLabelText('Device name'), 'Counter');
    await userEvent.type(screen.getByLabelText('Revenue Department POS ID'), 'POS-009');
    await userEvent.click(screen.getByRole('button', { name: 'Register device' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'devices',
      op: 'insert',
      values: {
        org_id: 'o1',
        store_id: 's1',
        name: 'Counter',
        role: 'cashier',
        station: null,
        revenue_pos_id: 'POS-009',
      },
    });
  });

  it('a kitchen screen needs a station; other devices never send one', async () => {
    const db = fakeDb({ devices: [], stores });
    mount(ctx(db.client));
    await screen.findByText(/No devices yet/);
    await userEvent.type(screen.getByLabelText('Device name'), 'Bar screen');
    await userEvent.selectOptions(screen.getByLabelText('Used as'), 'kds');
    await userEvent.selectOptions(screen.getByLabelText('Station'), 'bar');
    await userEvent.click(screen.getByRole('button', { name: 'Register device' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]!.values).toMatchObject({
      role: 'kds',
      station: 'bar',
      revenue_pos_id: null,
    });
  });

  it('refuses a bad POS ID and an empty name before calling the server', async () => {
    const db = fakeDb({ devices: [], stores });
    mount(ctx(db.client));
    await screen.findByText(/No devices yet/);
    await userEvent.click(screen.getByRole('button', { name: 'Register device' }));
    await screen.findAllByRole('alert');
    await userEvent.type(screen.getByLabelText('Device name'), 'X');
    await userEvent.type(screen.getByLabelText('Revenue Department POS ID'), 'no spaces!');
    await userEvent.click(screen.getByRole('button', { name: 'Register device' }));
    expect(await screen.findAllByText(/device details are not valid/)).toHaveLength(1);
    expect(db.writes).toHaveLength(0);
  });

  it('changes the POS ID of an existing device, and an empty value clears it', async () => {
    const db = fakeDb({ devices: [device], stores });
    mount(ctx(db.client));
    await screen.findByText('Counter iPad');
    const li = screen.getByText('Counter iPad').closest('li') as HTMLElement;
    const input = within(li).getByLabelText('Revenue Department POS ID') as HTMLInputElement;
    expect(input.value).toBe('POS-001');
    await userEvent.clear(input);
    await userEvent.type(input, 'POS-002');
    await userEvent.click(within(li).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ table: 'devices', values: { revenue_pos_id: 'POS-002' } });
    await userEvent.clear(input);
    await userEvent.click(within(li).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(2));
    expect(db.writes[1]!.values).toMatchObject({ revenue_pos_id: null });
  });

  it('switches a device off and on', async () => {
    const db = fakeDb({ devices: [device], stores });
    mount(ctx(db.client));
    await screen.findByText('Counter iPad');
    await userEvent.click(screen.getByRole('button', { name: 'Switch off device' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]!.values).toEqual({ active: false });
  });

  it('is read-only without settings permission', async () => {
    mount(
      ctx(fakeDb({ devices: [device], stores }).client, {
        isOwner: false,
        permissions: ['report.view'],
      }),
    );
    await screen.findByText('Counter iPad');
    expect((screen.getByLabelText('Revenue Department POS ID') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Register device' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('<DevicesPage> binding this tablet', () => {
  it('binds this tablet to a device (kept on the tablet), shows it, and unbinds', async () => {
    mount(ctx(fakeDb({ devices: [device], stores }).client));
    await screen.findByText('Counter iPad');
    await userEvent.click(screen.getByRole('button', { name: 'Use this tablet as this device' }));
    expect(JSON.parse(localStorage.getItem('bestie-device')!)).toMatchObject({
      deviceId: 'd1',
      storeId: 's1',
      orgId: 'o1',
      role: 'cashier',
      posId: 'POS-001',
    });
    expect(await screen.findByText('This tablet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop using this tablet as a till' }));
    expect(localStorage.getItem('bestie-device')).toBeNull();
  });

  it('a switched-off device cannot be bound', async () => {
    mount(ctx(fakeDb({ devices: [{ ...device, active: false }], stores }).client));
    await screen.findByText('Counter iPad');
    expect(screen.queryByRole('button', { name: 'Use this tablet as this device' })).toBeNull();
  });
});
