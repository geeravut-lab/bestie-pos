import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { AppointmentsPage } from './AppointmentsPage';
import { fakeDb } from './fakeDb';
import { ResourcesPage } from './ResourcesPage';

afterEach(cleanup);

const tables = () => ({
  resources: [
    { id: 'nok', name: 'Nok', kind: 'stylist', active: true, sort: 1 },
    { id: 'mai', name: 'Mai', kind: 'therapist', active: true, sort: 2 },
    { id: 'room1', name: 'Room 1', kind: 'room', active: true, sort: 3 },
  ],
  appointments: [
    {
      id: 'a1',
      provider_id: 'nok',
      place_id: 'room1',
      service_name: { th: 'นวดน้ำมัน', en: 'Oil massage' },
      price: 80000,
      guest_name: 'Anna',
      guest_phone: '081',
      starts_at: '2030-01-15T10:00:00+07:00',
      ends_at: '2030-01-15T11:30:00+07:00',
      status: 'booked',
      source: 'staff',
      note: null,
    },
    {
      id: 'a2',
      provider_id: null,
      place_id: null,
      service_name: { th: 'ตัดผม' },
      price: 30000,
      guest_name: 'Ben',
      guest_phone: null,
      starts_at: '2030-01-15T14:00:00+07:00',
      ends_at: '2030-01-15T14:45:00+07:00',
      status: 'confirmed',
      source: 'online',
      note: null,
    },
  ],
  menu_items: [
    {
      id: 'svc1',
      name: { th: 'นวดน้ำมัน', en: 'Oil massage' },
      prices: { base: 80000 },
      duration_min: 90,
    },
    {
      id: 'svc2',
      name: { th: 'ตัดผม', en: 'Haircut' },
      prices: { base: 30000 },
      duration_min: null,
    },
  ],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/calendar',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: () => true,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <AppointmentsPage ctx={c} />
    </I18nProvider>,
  );
const openDay = async () => {
  fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2030-01-15' } });
};

describe('<AppointmentsPage>', () => {
  it('says so when the module is off in this shop', async () => {
    mount(ctx(fakeDb(tables()).client, { isModuleOn: () => false }));
    expect(await screen.findByText(/appointments module is off/i)).toBeTruthy();
  });

  it('shows a column per stylist with the bookings, and an Unassigned column for bookings with nobody', async () => {
    mount(ctx(fakeDb(tables()).client));
    await openDay();
    const nok = await screen.findByRole('region', { name: 'Nok' });
    expect(within(nok).getByText('10:00 Anna')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Mai' })).toBeTruthy();
    const none = screen.getByRole('region', { name: 'Unassigned' });
    expect(within(none).getByText('14:00 Ben')).toBeTruthy();
  });

  it('switches to the room / bed view', async () => {
    mount(ctx(fakeDb(tables()).client));
    await openDay();
    await userEvent.click(await screen.findByRole('tab', { name: 'By room / bed' }));
    const room = await screen.findByRole('region', { name: 'Room 1' });
    expect(within(room).getByText('10:00 Anna')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Nok' })).toBeNull();
  });

  it('books from a column: the service fills the length, the time is Bangkok time on the chosen day', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByRole('button', { name: 'New booking: Mai' }));
    expect((screen.getByLabelText('Stylist / therapist') as HTMLSelectElement).value).toBe('mai');
    expect((screen.getByLabelText('Length (minutes)') as HTMLInputElement).value).toBe('90');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '15:30' } });
    await userEvent.type(screen.getByLabelText('Guest name'), 'Cara');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'book_appointment',
      args: {
        p: {
          store_id: 's1',
          provider_id: 'mai',
          place_id: null,
          service_id: 'svc1',
          duration_min: 90,
          starts_at: '2030-01-15T15:30:00+07:00',
          guest_name: 'Cara',
          guest_phone: null,
          note: undefined,
        },
      },
    });
  });

  it('warns before saving when the stylist is already booked then, and refuses an empty guest name', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByRole('button', { name: 'New booking: Nok' }));
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '11:00' } }); // inside 10:00–11:30
    expect(await screen.findByText(/Clashes with Anna at 10:00/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    expect(await screen.findByText(/Enter the guest name/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('a custom service needs a name; the database refusing a busy stylist is shown as such', async () => {
    const db = fakeDb(tables(), {
      rpc: {
        book_appointment: {
          error: { code: '23P01', message: 'that provider is busy at that time' },
        },
      },
    });
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByRole('button', { name: 'New booking: Nok' }));
    await userEvent.selectOptions(screen.getByLabelText('Service'), '');
    await userEvent.type(screen.getByLabelText('Guest name'), 'Dan');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    expect(await screen.findByText(/Enter the guest name/)).toBeTruthy(); // no service name yet
    await userEvent.type(screen.getByLabelText('Service name'), 'Nails');
    await userEvent.type(screen.getByLabelText('Price (baht)'), '250');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    expect(await screen.findByText('That stylist is busy then')).toBeTruthy();
    expect(db.rpcs[0]!.args).toMatchObject({
      p: { service_name: { th: 'Nails' }, price: 25000, duration_min: 90 },
    });
  });

  it('a booking opens its details with only the next steps; confirming goes through the database function', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    const card = screen.getByRole('region', { name: 'Anna' });
    expect(within(card).getByText('Booked')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Finish' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'set_appointment_status',
      args: { p_id: 'a1', p_status: 'confirmed' },
    });
  });

  it('moves a booking to another time', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    fireEvent.change(screen.getByLabelText('Move to'), { target: { value: '16:00' } });
    await userEvent.click(screen.getByRole('button', { name: 'Move booking' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'reschedule_appointment',
      args: {
        p: {
          id: 'a1',
          starts_at: '2030-01-15T16:00:00+07:00',
          provider_id: 'nok',
          place_id: 'room1',
        },
      },
    });
  });

  it('someone without order.create can look but not book or change', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: [] }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    expect(screen.queryByRole('button', { name: /New booking/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
  });
});

describe('<ResourcesPage>', () => {
  const mountR = (c: PageContext) =>
    render(
      <I18nProvider initialLang="en">
        <ResourcesPage ctx={c} />
      </I18nProvider>,
    );
  const rctx = (client: unknown, over: Partial<PageContext> = {}) =>
    ctx(client, { path: '/resources', permissions: ['menu.edit'], ...over });

  it('lists stylists and rooms and adds a stylist', async () => {
    const db = fakeDb(tables());
    mountR(rctx(db.client));
    expect(await screen.findByText('Nok')).toBeTruthy();
    expect(screen.getByText('Room 1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Fon');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'resources',
      op: 'insert',
      values: { name: 'Fon', kind: 'stylist', store_id: 's1' },
    });
  });

  it('offers rooms and beds only when the resources module is on', async () => {
    mountR(rctx(fakeDb(tables()).client, { isModuleOn: (id) => id !== 'resources' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const kinds = within(screen.getByLabelText('Type'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(kinds).toEqual(['Stylist / beautician', 'Therapist']);
  });

  it('stops using a stylist who left', async () => {
    const db = fakeDb(tables());
    mountR(rctx(db.client));
    const row = (await screen.findByText('Nok')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Stop using' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'resources',
      op: 'update',
      values: { active: false },
    });
  });

  it('someone without menu.edit only looks', async () => {
    mountR(rctx(fakeDb(tables()).client, { permissions: [] }));
    expect(await screen.findByText('Nok')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop using' })).toBeNull();
  });
});
