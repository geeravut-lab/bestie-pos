import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { DaysOffPage } from './DaysOffPage';
import { fakeDb } from './fakeDb';
import { GroupBookingPage } from './GroupBookingPage';

afterEach(cleanup);

const resources = [
  { id: 'r1', name: 'Nok', kind: 'stylist', active: true, sort: 1, staff_id: null },
  { id: 'r2', name: 'Fon', kind: 'stylist', active: true, sort: 2, staff_id: null },
];
const tables = (extra: Record<string, unknown[]> = {}) => ({
  resources,
  menu_items: [{ id: 'svc1', name: { th: 'นวด', en: 'Massage' }, duration_min: 60 }],
  resource_blocks: [
    {
      id: 'b1',
      resource_id: 'r1',
      starts_at: '2099-01-01T00:00:00Z',
      ends_at: '2099-01-02T00:00:00Z',
      reason: 'holiday',
    },
  ],
  ...extra,
});
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

describe('<DaysOffPage>', () => {
  it('lists upcoming days off and saves a new one through the database function', async () => {
    const db = fakeDb(tables());
    wrap(<DaysOffPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('holiday')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'lunch');
    await userEvent.click(screen.getByRole('button', { name: 'Save the day off' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_resource_block')).toBe(true));
    const call = db.rpcs.find((r) => r.fn === 'save_resource_block')!.args as {
      p: Record<string, string>;
    };
    expect(call.p.store_id).toBe('s1');
    expect(call.p.resource_id).toBe('r1');
    expect(call.p.reason).toBe('lunch');
    expect(Date.parse(call.p.ends_at!)).toBeGreaterThan(Date.parse(call.p.starts_at!));
  });

  it('shows a clear message when bookings are in the way', async () => {
    const db = fakeDb(tables(), { rpc: { save_resource_block: { error: { code: '23P01' } } } });
    wrap(<DaysOffPage ctx={ctx(db.client)} />);
    await screen.findByText('holiday');
    await userEvent.click(screen.getByRole('button', { name: 'Save the day off' }));
    expect(await screen.findByText(/already has bookings/)).toBeTruthy();
  });

  it('removes a block', async () => {
    const db = fakeDb(tables());
    wrap(<DaysOffPage ctx={ctx(db.client)} />);
    await screen.findByText('holiday');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(db.rpcs.find((r) => r.fn === 'delete_resource_block')?.args).toEqual({ p_id: 'b1' }),
    );
  });

  it('a person without menu.edit can look but not change', async () => {
    const db = fakeDb(tables());
    wrap(<DaysOffPage ctx={ctx(db.client, { permissions: ['order.create'] })} />);
    await screen.findByText('holiday');
    expect(screen.queryByRole('button', { name: 'Save the day off' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});

describe('<GroupBookingPage>', () => {
  it('books a couple in one call: two parts, one start time', async () => {
    const db = fakeDb(tables(), {
      rpc: { book_group: { data: { group_id: 'g', ids: ['a', 'b'] } } },
    });
    wrap(<GroupBookingPage ctx={ctx(db.client, { path: '/group-booking' })} />);
    await screen.findByText('Person 1');
    await userEvent.type(screen.getByLabelText('Booked by'), 'Lee');
    for (const i of [0, 1]) {
      await userEvent.selectOptions(
        screen.getByLabelText('Service', { selector: `#grp-svc-${i}` }),
        'svc1',
      );
      await userEvent.selectOptions(
        screen.getByLabelText('Stylist / therapist', { selector: `#grp-prov-${i}` }),
        i === 0 ? 'r1' : 'r2',
      );
    }
    await userEvent.click(screen.getByRole('button', { name: 'Book the whole group' }));
    expect(await screen.findByText(/2 bookings made/)).toBeTruthy();
    const call = db.rpcs.find((r) => r.fn === 'book_group')!.args as {
      p: { parts: { provider_id: string }[]; guest_name: string };
    };
    expect(call.p.guest_name).toBe('Lee');
    expect(call.p.parts.map((x) => x.provider_id)).toEqual(['r1', 'r2']);
  });

  it('asks for the missing pieces instead of calling the server', async () => {
    const db = fakeDb(tables());
    wrap(<GroupBookingPage ctx={ctx(db.client, { path: '/group-booking' })} />);
    await screen.findByText('Person 1');
    await userEvent.click(screen.getByRole('button', { name: 'Book the whole group' }));
    expect(await screen.findByText(/at least 2 people/)).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
  });

  it('says nobody was booked when someone is busy', async () => {
    const db = fakeDb(tables(), { rpc: { book_group: { error: { code: '23P01' } } } });
    wrap(<GroupBookingPage ctx={ctx(db.client, { path: '/group-booking' })} />);
    await screen.findByText('Person 1');
    await userEvent.type(screen.getByLabelText('Booked by'), 'Lee');
    for (const i of [0, 1]) {
      await userEvent.selectOptions(
        screen.getByLabelText('Service', { selector: `#grp-svc-${i}` }),
        'svc1',
      );
      await userEvent.selectOptions(
        screen.getByLabelText('Stylist / therapist', { selector: `#grp-prov-${i}` }),
        i === 0 ? 'r1' : 'r2',
      );
    }
    await userEvent.click(screen.getByRole('button', { name: 'Book the whole group' }));
    expect(await screen.findByText(/nobody was booked/)).toBeTruthy();
  });
});
