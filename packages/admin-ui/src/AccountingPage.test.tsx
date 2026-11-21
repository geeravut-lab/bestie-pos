import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { AccountingPage } from './AccountingPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/settings/accounting',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['report.view'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

describe('<AccountingPage>', () => {
  it("shows the owner's defaults and saves a change through the database function", async () => {
    const db = fakeDb(
      { staff_tips: [], staff: [] },
      { rpc: { service_policy: { data: {} }, save_service_policy: { data: {} } } },
    );
    wrap(<AccountingPage ctx={ctx(db.client)} />);
    const net = await screen.findByLabelText(/Amount before VAT and after all discounts/);
    expect((net as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByLabelText(/Recognised in full at the sale/));
    await userEvent.click(screen.getByRole('button', { name: 'Save the policy' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_service_policy')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'save_service_policy')!.args).toEqual({
      p_store: 's1',
      p: {
        commission_base: 'net',
        deposit_invoice: true,
        noshow_fee_vat: true,
        package_revenue: 'at_sale',
      },
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });
  it('a manager can read but not change the policy', async () => {
    const db = fakeDb({ staff_tips: [], staff: [] }, { rpc: { service_policy: { data: {} } } });
    wrap(<AccountingPage ctx={ctx(db.client, { isOwner: false })} />);
    expect(await screen.findByText('Only the owner can change the policy.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save the policy' })).toBeNull();
  });
  it('shows the package income received in advance and the tips of each person', async () => {
    const db = fakeDb(
      {
        staff_tips: [
          { staff_id: 'p1', amount: 10000, status: 'paid', created_at: '2026-11-10T05:00:00Z' },
          { staff_id: 'p1', amount: 5000, status: 'owed', created_at: '2026-11-11T05:00:00Z' },
        ],
        staff: [{ id: 'p1', display_name: 'Nok' }],
      },
      {
        rpc: {
          service_policy: { data: {} },
          package_deferred_report: {
            data: {
              as_of: '2026-11-21',
              policy: 'deferred',
              sold: 800000,
              released_by_visits: 80000,
              released_by_expiry: 0,
              deferred: 720000,
              rows: [
                {
                  id: 'c1',
                  name: { th: 'นวด', en: 'Massage x10' },
                  member: 'Anna',
                  price: 800000,
                  used: 80000,
                  valid_until: '2027-01-01',
                  expired: false,
                  released_by_expiry: 0,
                  deferred: 720000,
                },
              ],
            },
          },
        },
      },
    );
    wrap(<AccountingPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('Nok')).toBeTruthy();
    expect(screen.getByText('฿150')).toBeTruthy(); // taken
    await userEvent.click(screen.getByRole('button', { name: 'Show the report' }));
    expect(await screen.findByText('Massage x10')).toBeTruthy();
    expect(screen.getByText('฿7,200', { selector: 'strong' })).toBeTruthy();
    expect(db.rpcs.find((r) => r.fn === 'package_deferred_report')!.args).toMatchObject({
      p: { org_id: 'o1', store_id: 's1' },
    });
  });
});
