import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { CounterReminder } from './CounterReminder';
import { DaysOffPage } from './DaysOffPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/days-off',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit', 'order.create'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const tables = () => ({
  resources: [{ id: 'r1', name: 'Nok', kind: 'stylist', active: true, sort: 1, staff_id: null }],
  resource_blocks: [],
  resource_weekly_offs: [
    {
      id: 'w1',
      resource_id: 'r1',
      weekday: 1,
      from_time: '00:00:00',
      to_time: null,
      reason: 'rest',
    },
  ],
});

describe('weekly days off', () => {
  it('lists them and saves a new one through the database function', async () => {
    const db = fakeDb(tables());
    wrap(<DaysOffPage ctx={ctx(db.client)} />);
    expect(await screen.findByText(/Every Monday/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    await userEvent.click(screen.getByRole('button', { name: 'Friday' }));
    await userEvent.click(screen.getByLabelText('All day'));
    await userEvent.click(screen.getByRole('button', { name: 'Repeat every week' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_weekly_off')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'save_weekly_off')!.args).toEqual({
      p: {
        store_id: 's1',
        resource_id: 'r1',
        weekdays: [3, 5],
        from_time: '12:00',
        to_time: '13:00',
        reason: null,
      },
    });
  });
  it('needs a weekday, and says plainly when bookings are in the way', async () => {
    const db = fakeDb(tables(), { rpc: { save_weekly_off: { error: { code: '23P01' } } } });
    wrap(<DaysOffPage ctx={ctx(db.client)} />);
    await screen.findByText(/Every Monday/);
    await userEvent.click(screen.getByRole('button', { name: 'Repeat every week' }));
    expect(await screen.findByText(/Choose at least one day/)).toBeTruthy();
    expect(db.rpcs.some((r) => r.fn === 'save_weekly_off')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
    await userEvent.click(screen.getByRole('button', { name: 'Repeat every week' }));
    expect(await screen.findByText(/move or cancel them first/)).toBeTruthy();
  });
  it('removes one', async () => {
    const db = fakeDb(tables());
    wrap(<DaysOffPage ctx={ctx(db.client)} />);
    await screen.findByText(/Every Monday/);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(db.rpcs.find((r) => r.fn === 'delete_weekly_off')?.args).toEqual({ p_id: 'w1' }),
    );
  });
});

describe('<CounterReminder>', () => {
  it('saves the e-mail and shows a one-time code for LINE', async () => {
    const db = fakeDb({}, { rpc: { appointment_guest_code: { data: 'AB12CD34' } } });
    wrap(<CounterReminder ctx={ctx(db.client)} appointmentId="a1" />);
    await userEvent.type(screen.getByLabelText('Guest e-mail'), 'anna@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save the e-mail' }));
    await waitFor(() =>
      expect(db.rpcs.find((r) => r.fn === 'set_appointment_contact')?.args).toEqual({
        p_appt: 'a1',
        p_email: 'anna@example.com',
      }),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show a code for LINE' }));
    expect(await screen.findByText('AB12CD34')).toBeTruthy();
  });
});
