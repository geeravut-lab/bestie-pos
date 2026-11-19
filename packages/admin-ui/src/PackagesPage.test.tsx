import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { PackagesPage } from './PackagesPage';

afterEach(cleanup);

const tables = () => ({
  service_packages: [
    {
      id: 'p1',
      name: { th: 'นวด 10 ครั้ง', en: 'Massage x10' },
      price: 800000,
      visits: 10,
      valid_days: 180,
      active: true,
    },
    {
      id: 'p2',
      name: { th: 'สปา 5 ครั้ง', en: 'Spa x5' },
      price: 500000,
      visits: 5,
      valid_days: null,
      active: false,
    },
  ],
  customer_packages: [
    {
      id: 'c1',
      customer_id: 'm1',
      name: { th: 'นวด 10 ครั้ง', en: 'Massage x10' },
      price: 800000,
      visits_total: 10,
      visits_left: 7,
      valid_until: '2099-05-01',
      status: 'active',
    },
    {
      id: 'c2',
      customer_id: 'm1',
      name: { th: 'เก่า', en: 'Old pack' },
      price: 100000,
      visits_total: 5,
      visits_left: 2,
      valid_until: '2020-01-01',
      status: 'active',
    },
    {
      id: 'c3',
      customer_id: 'm1',
      name: { th: 'รอ', en: 'Pending pack' },
      price: 100000,
      visits_total: 5,
      visits_left: 5,
      valid_until: null,
      status: 'pending',
    },
  ],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/packages',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit', 'order.create'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: () => true,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <PackagesPage ctx={c} />
    </I18nProvider>,
  );

// a member found by the picker
const memberRpc = {
  find_customers: {
    data: [
      { id: 'm1', name: 'Anna Smith', phone: '66812345678', member_code: 'ABCD1234', points: 0 },
    ],
  },
};
const findAnna = async () => {
  await userEvent.type(await screen.findByLabelText('Find a member'), 'anna');
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
  await userEvent.click(await screen.findByRole('button', { name: /Anna Smith/ }));
};

describe('<PackagesPage>', () => {
  it('says so when the module is off', async () => {
    mount(ctx(fakeDb(tables()).client, { isModuleOn: () => false }));
    expect(await screen.findByText(/packages module is off/)).toBeTruthy();
  });

  it('lists the packages with visits, value per visit and validity', async () => {
    mount(ctx(fakeDb(tables()).client));
    const a = (await screen.findByText('Massage x10')).closest('li')!;
    expect(within(a).getByText('฿8,000')).toBeTruthy();
    expect(
      within(a).getByText(/10 visits · ฿800 a visit · valid 180 days after payment/),
    ).toBeTruthy();
    const b = screen.getByText('Spa x5').closest('li')!;
    expect(within(b).getByText('Not on sale')).toBeTruthy();
    expect(within(b).getByText(/no expiry/)).toBeTruthy();
  });

  it('adds a package: price in satang, visits and days as numbers', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Add a package' }));
    await userEvent.type(screen.getByLabelText('Name (Thai)'), 'สระผม 6 ครั้ง');
    await userEvent.type(screen.getByLabelText('Package price (baht)'), '1,200');
    const visits = screen.getByLabelText('Number of visits');
    await userEvent.clear(visits);
    await userEvent.type(visits, '6');
    await userEvent.click(screen.getByRole('button', { name: 'Save the package' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'service_packages',
      op: 'insert',
      values: {
        name: { th: 'สระผม 6 ครั้ง' },
        price: 120000,
        visits: 6,
        valid_days: 180,
        active: true,
      },
    });
  });

  it('refuses a package with no visits or a silly price before anything is saved', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Add a package' }));
    await userEvent.type(screen.getByLabelText('Name (Thai)'), 'x');
    await userEvent.type(screen.getByLabelText('Package price (baht)'), '100');
    const visits = screen.getByLabelText('Number of visits');
    await userEvent.clear(visits);
    await userEvent.type(visits, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save the package' }));
    expect(await screen.findByText(/1–100 visits/)).toBeTruthy();
    expect(db.writes).toHaveLength(0);
  });

  it('without menu.edit the catalogue is read-only', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: ['order.create'] }));
    expect(await screen.findByText('Massage x10')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a package' })).toBeNull();
  });

  it("shows a member's packages with what is left, expired ones as expired, and sells a package on a bill", async () => {
    const db = fakeDb(tables(), { rpc: { ...memberRpc, sell_package: { data: 'order-9' } } });
    const navigate = vi.fn();
    mount(ctx(db.client, { navigate }));
    await findAnna();
    const mine = within(await screen.findByRole('region', { name: "A member's packages" }));
    const live = (await mine.findByText('Massage x10', { selector: 'strong' })).closest('li')!;
    expect(within(live).getByText('Active')).toBeTruthy();
    expect(within(live).getByText(/7 of 10 visits left · valid until 2099-05-01/)).toBeTruthy();
    expect(within(mine.getByText('Old pack').closest('li')!).getByText('Expired')).toBeTruthy();
    expect(
      within(mine.getByText('Pending pack').closest('li')!).getByText('Waiting for payment'),
    ).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Sell a package to this member'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Open the bill for the package' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'sell_package')).toBe(true));
    expect(db.rpcs.find((c) => c.fn === 'sell_package')!.args).toEqual({
      p: { store_id: 's1', package_id: 'p1', customer_id: 'm1' },
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/order/order-9'));
  });

  it('only packages on sale are offered for selling; a person without order.create cannot sell', async () => {
    const db = fakeDb(tables(), { rpc: memberRpc });
    mount(ctx(db.client));
    await findAnna();
    const sel = await screen.findByLabelText('Sell a package to this member');
    expect(
      within(sel)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['— none —', 'Massage x10 · ฿8,000']);
    cleanup();
    mount(ctx(fakeDb(tables(), { rpc: memberRpc }).client, { permissions: ['menu.edit'] }));
    await findAnna();
    await screen.findByRole('region', { name: "A member's packages" });
    await screen.findByText('Old pack');
    expect(screen.queryByLabelText('Sell a package to this member')).toBeNull();
  });
});
