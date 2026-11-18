import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { BillingPage } from './BillingPage';

afterEach(cleanup);

type Store = {
  id: string;
  name: string;
  vat_registered: boolean;
  vat_bps: number;
  service_charge_bps: number;
  price_mode: string;
  rounding: unknown;
  bill_options: unknown;
};
const store = (over: Partial<Store> = {}): Store => ({
  id: 's1',
  name: 'Acme',
  vat_registered: true,
  vat_bps: 700,
  service_charge_bps: 1000,
  price_mode: 'inclusive',
  rounding: {},
  bill_options: {},
  ...over,
});

function fakeClient(
  opts: {
    stores?: Store[];
    points?: unknown;
    updatedRows?: number;
    devices?: { id: string; store_id: string; name: string }[];
  } = {},
) {
  const updates: { table: string; values: unknown }[] = [];
  const from = vi.fn((table: string) => {
    let updated = false;
    const chain: Record<string, unknown> = {};
    chain.select = () =>
      updated
        ? Promise.resolve({
            data: Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: 'x' })),
            error: null,
          })
        : chain;
    chain.eq = () => chain;
    chain.is = () => chain;
    chain.order = async () => ({
      data: table === 'devices' ? (opts.devices ?? []) : (opts.stores ?? [store()]),
      error: null,
    });
    chain.maybeSingle = async () => ({ data: { points_rule: opts.points ?? {} }, error: null });
    chain.update = (values: unknown) => {
      updated = true;
      updates.push({ table, values });
      return chain;
    };
    return chain;
  });
  return { client: { from } as never, updates };
}

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/settings/billing',
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
      <BillingPage ctx={c} />
    </I18nProvider>,
  );
const preview = () => screen.getByText(/Sample bill/).closest('.preview-box') as HTMLElement;

describe('<BillingPage> store billing', () => {
  it('shows the sample bill for the current choices and recalculates when an option changes', async () => {
    mount(ctx(fakeClient().client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    // goods 1,000 + 10 % service = 1,100 (VAT-inclusive prices, service taxable): VAT = 1,100 × 7/107 = 71.96
    expect(within(preview()).getByText('฿71.96')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'No — VAT only on the goods' }));
    expect(within(preview()).getByText('฿65.42')).toBeTruthy(); // VAT only on the goods: 1,000 × 7/107
    await userEvent.click(screen.getByRole('radio', { name: 'Nearest baht' }));
    expect(within(preview()).getAllByText('฿1,100')).toHaveLength(2); // total and cash total
  });

  it('cash rounding changes only the cash line', async () => {
    mount(ctx(fakeClient({ stores: [store({ service_charge_bps: 700 })] }).client)); // total 1,070
    await screen.findByRole('heading', { name: 'Billing & points' });
    await userEvent.click(screen.getByRole('radio', { name: 'Round down to the baht' }));
    const dd = within(preview()).getAllByText('฿1,070');
    expect(dd).toHaveLength(2);
    await userEvent.clear(screen.getByLabelText('Service charge (%)'));
    await userEvent.type(screen.getByLabelText('Service charge (%)'), '7.35');
    expect(within(preview()).getByText('฿1,073.50')).toBeTruthy(); // exact total
    expect(within(preview()).getByText('฿1,073')).toBeTruthy(); // cash rounded down
  });

  it('saves the choices as data: only differences from the defaults are stored', async () => {
    const { client, updates } = fakeClient();
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    await userEvent.click(screen.getByRole('radio', { name: 'The amount before discounts' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Nearest 25 satang' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({
      table: 'stores',
      values: {
        vat_registered: true,
        vat_bps: 700,
        service_charge_bps: 1000,
        price_mode: 'inclusive',
        bill_options: { serviceChargeBase: 'before_discounts' },
        rounding: { cash: 'nearest-25' },
        shift_required: false,
        qr_auto_send: false,
        qr_pay_device: null,
      },
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('a shop that is not VAT-registered saves 0 % VAT', async () => {
    const { client, updates } = fakeClient();
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    await userEvent.click(screen.getByRole('switch', { name: 'The shop is VAT-registered' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]!.values).toMatchObject({ vat_registered: false, vat_bps: 0 });
  });

  it('rejects invalid numbers before saving', async () => {
    const { client, updates } = fakeClient();
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    await userEvent.clear(screen.getByLabelText('Service charge (%)'));
    await userEvent.type(screen.getByLabelText('Service charge (%)'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not valid');
    expect(updates).toHaveLength(0);
  });

  it('is read-only without the settings permission and lets owners with several shops pick the shop', async () => {
    mount(ctx(fakeClient().client, { isOwner: false, permissions: [] }));
    await screen.findByRole('heading', { name: 'Billing & points' });
    expect(screen.queryByRole('button', { name: 'Save billing settings' })).toBeNull();
    expect((screen.getByLabelText('Service charge (%)') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    mount(
      ctx(
        fakeClient({ stores: [store(), store({ id: 's2', name: 'Beach', service_charge_bps: 0 })] })
          .client,
      ),
    );
    await userEvent.selectOptions(await screen.findByLabelText('Shop'), 's2');
    expect((screen.getByLabelText('Service charge (%)') as HTMLInputElement).value).toBe('0');
  });

  it('reports a refused save (no row touched) instead of pretending it worked', async () => {
    const { client } = fakeClient({ updatedRows: 0 });
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    await userEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn');
  });
});

describe('<BillingPage> points rule', () => {
  it('shows the rule, previews it, and saves only differences from the default', async () => {
    const { client, updates } = fakeClient();
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Points rule' });
    expect(
      screen.getByText(/Example: spending ฿500 earns 20 points · 100 points = ฿100 off/),
    ).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Baht spent per 1 point'));
    await userEvent.type(screen.getByLabelText('Baht spent per 1 point'), '50');
    await userEvent.click(
      screen.getByRole('switch', { name: 'Paying with Bestie Credit also earns points' }),
    );
    expect(screen.getByText(/earns 10 points/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save points rule' }));
    await waitFor(() => expect(updates.some((u) => u.table === 'orgs')).toBe(true));
    expect(updates.find((u) => u.table === 'orgs')!.values).toEqual({
      points_rule: { earnSatangPerPoint: 5000, creditEarnsPoints: false },
    });
  });

  it('says that points can never be bought or cashed out and refuses out-of-range values', async () => {
    const { client, updates } = fakeClient();
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Points rule' });
    expect(screen.getByText(/never be bought or cashed out/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Points can cover at most (% of the bill)'));
    await userEvent.type(screen.getByLabelText('Points can cover at most (% of the bill)'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Save points rule' }));
    expect(
      (await screen.findAllByRole('alert')).some((a) => a.textContent?.includes('not valid')),
    ).toBe(true);
    expect(updates.filter((u) => u.table === 'orgs')).toHaveLength(0);
  });

  it('loads a stored rule', async () => {
    mount(ctx(fakeClient({ points: { earnSatangPerPoint: 10000, maxRedeemBps: 2000 } }).client));
    await screen.findByRole('heading', { name: 'Points rule' });
    expect((screen.getByLabelText('Baht spent per 1 point') as HTMLInputElement).value).toBe('100');
    expect(
      (screen.getByLabelText('Points can cover at most (% of the bill)') as HTMLInputElement).value,
    ).toBe('20');
  });
});

describe('<BillingPage> shift switch', () => {
  it('lets the owner require an open shift before payments, saved with the shop settings', async () => {
    const { client, updates } = fakeClient();
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    const sw = screen.getByRole('switch', {
      name: 'Require an open shift before taking payment',
    }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await userEvent.click(sw);
    await userEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    await waitFor(() =>
      expect(
        updates.some(
          (u) =>
            u.table === 'stores' &&
            (u.values as { shift_required?: boolean }).shift_required === true,
        ),
      ).toBe(true),
    );
  });
});

describe('<BillingPage> QR auto-send switch', () => {
  it('lets the owner send guest QR orders straight to the kitchen', async () => {
    const { client, updates } = fakeClient();
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    const sw = screen.getByRole('switch', {
      name: /Orders from guests by QR go straight to the kitchen/,
    }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await userEvent.click(sw);
    await userEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    await waitFor(() =>
      expect(
        updates.some((u) => (u.values as { qr_auto_send?: boolean }).qr_auto_send === true),
      ).toBe(true),
    );
  });
});

describe('<BillingPage> pay at the table device', () => {
  it('is off by default and lets the owner pick which device’s receipts guest payments use', async () => {
    const { client, updates } = fakeClient({
      devices: [
        { id: 'd1', store_id: 's1', name: 'Counter' },
        { id: 'd2', store_id: 'other', name: 'Other shop till' },
      ],
    });
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Billing & points' });
    const sel = screen.getByLabelText(
      /Device whose receipts guest payments use/,
    ) as HTMLSelectElement;
    expect(sel.value).toBe('');
    expect(within(sel).queryByText('Other shop till')).toBeNull();
    await userEvent.selectOptions(sel, 'd1');
    await userEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    await waitFor(() =>
      expect(
        updates.some((u) => (u.values as { qr_pay_device?: string }).qr_pay_device === 'd1'),
      ).toBe(true),
    );
  });
});
