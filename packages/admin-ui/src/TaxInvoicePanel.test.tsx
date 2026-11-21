import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { TaxInvoicePanel } from './TaxInvoicePanel';
import { TaxProfilePanel } from './TaxProfilePanel';

afterEach(cleanup);

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/receipt',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['payment.take'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const receipt = (vatRegistered: boolean) => ({
  number: 'A-000001',
  issued_at: '2026-11-20T05:00:00Z',
  seller_name: 'Island Cafe Co',
  seller_tax_id: '0105551234567',
  branch_code: '00000',
  vat_registered: vatRegistered,
  vat_bps: 700,
  subtotal: 10700,
  service_charge: 0,
  vat: 700,
  net_before_vat: 10000,
  total: 10700,
  rounding: 0,
  payable: 10700,
  store_id: 's1',
});
const tables = (vat = true, invoices: unknown[] = []) => ({
  receipts: [receipt(vat)],
  order_lines: [
    { name: { th: 'กาแฟ', en: 'Coffee' }, unit_price: 5350, quantity: 2, status: 'sent' },
  ],
  tax_invoices: invoices,
  stores: [{ address: 'Branch Rd', legal_entities: { address: 'Company Rd' } }],
});

describe('<TaxInvoicePanel>', () => {
  it('shows nothing for a shop that is not VAT registered', async () => {
    const db = fakeDb(tables(false));
    wrap(<TaxInvoicePanel ctx={ctx(db.client)} orderId="o9" />);
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByText('Full tax invoice')).toBeNull();
  });

  it('issues an invoice with the buyer details', async () => {
    const db = fakeDb(tables());
    wrap(<TaxInvoicePanel ctx={ctx(db.client)} orderId="o9" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ask for a full tax invoice' }),
    );
    await userEvent.type(screen.getByLabelText('Buyer name (company / person)'), 'ACME Ltd');
    await userEvent.type(screen.getByLabelText('Buyer tax ID (13 digits)'), '0105559999999');
    await userEvent.type(screen.getByLabelText('Buyer address'), '1 Beach Road, Koh Phangan');
    await userEvent.click(screen.getByRole('button', { name: 'Issue the full tax invoice' }));
    await waitFor(() => expect(db.rpcs.length).toBe(1));
    expect(db.rpcs[0]).toMatchObject({
      fn: 'issue_tax_invoice',
      args: {
        p: {
          order_id: 'o9',
          buyer_name: 'ACME Ltd',
          buyer_tax_id: '0105559999999',
          buyer_branch: '00000',
          buyer_address: '1 Beach Road, Koh Phangan',
        },
      },
    });
  });

  it('refuses a short tax ID before asking the server', async () => {
    const db = fakeDb(tables());
    wrap(<TaxInvoicePanel ctx={ctx(db.client)} orderId="o9" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ask for a full tax invoice' }),
    );
    await userEvent.type(screen.getByLabelText('Buyer name (company / person)'), 'ACME');
    await userEvent.type(screen.getByLabelText('Buyer tax ID (13 digits)'), '123');
    await userEvent.type(screen.getByLabelText('Buyer address'), '1 Beach Road');
    await userEvent.click(screen.getByRole('button', { name: 'Issue the full tax invoice' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
  });

  it('lists an issued invoice and cancels it with a reason (refund permission only)', async () => {
    const inv = {
      id: 'ti1',
      number: 'TI-000001',
      issued_at: '2026-11-20T06:00:00Z',
      buyer_name: 'ACME Ltd',
      buyer_tax_id: '0105559999999',
      buyer_branch: '00000',
      buyer_address: '1 Beach Road',
      status: 'issued',
    };
    const db = fakeDb(tables(true, [inv]));
    const { unmount } = wrap(<TaxInvoicePanel ctx={ctx(db.client)} orderId="o9" />);
    expect(await screen.findByText('TI-000001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel this tax invoice' })).toBeNull();
    unmount();
    wrap(
      <TaxInvoicePanel
        ctx={ctx(db.client, { permissions: ['payment.take', 'refund.create'] })}
        orderId="o9"
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel this tax invoice' }));
    await userEvent.type(screen.getByLabelText('Why it is cancelled'), 'wrong name');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the cancellation' }));
    await waitFor(() =>
      expect(db.rpcs.at(-1)).toMatchObject({
        fn: 'cancel_tax_invoice',
        args: { p_id: 'ti1', p_reason: 'wrong name' },
      }),
    );
  });
});

describe('<TaxProfilePanel>', () => {
  it('saves both addresses (owner only)', async () => {
    const db = fakeDb(tables());
    wrap(<TaxProfilePanel ctx={ctx(db.client, { isOwner: true })} storeId="s1" />);
    const company = await screen.findByLabelText('Company address');
    await waitFor(() => expect((company as HTMLTextAreaElement).value).toBe('Company Rd'));
    await userEvent.clear(company);
    await userEvent.type(company, 'New Rd');
    await userEvent.click(screen.getByRole('button', { name: 'Save the addresses' }));
    await waitFor(() => expect(db.rpcs.length).toBe(1));
    expect(db.rpcs[0]).toMatchObject({
      fn: 'save_tax_profile',
      args: { p: { store_id: 's1', company_address: 'New Rd', branch_address: 'Branch Rd' } },
    });
  });
  it('is hidden from a non-owner', () => {
    const db = fakeDb(tables());
    wrap(<TaxProfilePanel ctx={ctx(db.client)} storeId="s1" />);
    expect(screen.queryByLabelText('Company address')).toBeNull();
  });
});
