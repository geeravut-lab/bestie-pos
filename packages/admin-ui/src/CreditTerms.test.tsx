import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { CreditLiabilityPanel } from './CreditLiabilityPanel';
import { CreditPanel } from './CreditPanel';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/customers',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  homeStoreId: 's1',
  permissions: ['payment.take', 'customer.view'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const card = { id: 'c1', name: 'Anna', phone: '', memberCode: 'ABCD1234', points: 0 } as never;
const tables = (accepted: boolean) => ({
  stores: [
    { id: 's1', legal_entity_id: 'e1', name: 'Cafe', module_overrides: { 'tender.credit': true } },
  ],
  legal_entities: [{ name: 'Island Co' }],
  credit_ledger: [],
  credit_terms_acceptances: accepted ? [{ id: 'a1' }] : [],
  devices: [],
});

describe('<CreditPanel> terms', () => {
  it('shows the terms and the company, and offers no top-up until the customer has accepted', async () => {
    const db = fakeDb(tables(false), { rpc: { credit_balance: { data: 0 } } });
    wrap(<CreditPanel ctx={ctx(db.client)} card={card} />);
    expect(await screen.findByText(/Bestie Credit terms/)).toBeTruthy();
    expect(screen.getByText(/only at the shops of Island Co: Cafe/)).toBeTruthy();
    expect(screen.queryByLabelText(/Amount/i)).toBeNull();
    const rec = screen.getByRole('button', { name: 'Record the acceptance' }) as HTMLButtonElement;
    expect(rec.disabled).toBe(true);
    await userEvent.click(screen.getByLabelText(/The customer has read and accepts/));
    await userEvent.click(rec);
    await waitFor(() =>
      expect(db.rpcs.find((r) => r.fn === 'accept_credit_terms')?.args).toEqual({
        p_customer: 'c1',
        p_store: 's1',
      }),
    );
  });
  it('after the acceptance the top-up form is there and the terms are gone', async () => {
    const db = fakeDb(tables(true), { rpc: { credit_balance: { data: 0 } } });
    wrap(<CreditPanel ctx={ctx(db.client)} card={card} />);
    expect(await screen.findByRole('button', { name: /Top up/i })).toBeTruthy();
    expect(screen.queryByText(/Terms version/)).toBeNull();
  });
});

describe('<CreditLiabilityPanel>', () => {
  it('shows what is owed per company, with the crypto share, and which shops sell whose Credit', async () => {
    const db = fakeDb(
      {},
      {
        rpc: {
          credit_entity_check: {
            data: [
              {
                store_id: 's1',
                store: 'Cafe',
                entity_id: 'e1',
                entity: 'Island Co',
                tax_id_set: false,
                credit_on: true,
              },
            ],
          },
          credit_liability_detail: {
            data: [
              {
                legal_entity_id: 'e1',
                name: 'Island Co',
                tax_id: '',
                topped_up: 150000,
                topped_up_cash: 100000,
                topped_up_psp: 30000,
                topped_up_crypto: 20000,
                spent: 40000,
                adjusted: 0,
                outstanding: 110000,
                customers: 2,
              },
            ],
          },
        },
      },
    );
    wrap(<CreditLiabilityPanel ctx={ctx(db.client, { isOwner: true })} />);
    expect(await screen.findByText(/This company has no 13-digit tax ID/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('฿1,100', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('฿200')).toBeTruthy(); // crypto
    expect(db.rpcs.find((r) => r.fn === 'credit_liability_detail')!.args).toMatchObject({
      p_org: 'o1',
    });
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeTruthy();
  });
});
