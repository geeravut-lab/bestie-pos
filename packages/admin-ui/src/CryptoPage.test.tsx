import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import type { CustomerCard } from '@bestie/core';
import { CryptoPage } from './CryptoPage';
import { CryptoPanel } from './CryptoPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // a real, checksum-valid Tron address
const CARD: CustomerCard = {
  id: 'c1',
  name: 'Anna Smith',
  phone: '66812345678',
  memberCode: 'AB12CD34',
  points: 0,
};

function client(
  opts: {
    module?: boolean;
    kyc?: unknown;
    rpc?: Record<string, { data?: unknown; error?: { code: string } | null }>;
    tables?: Record<string, unknown[]>;
    reqStatus?: string;
  } = {},
) {
  const rpc = vi.fn(async (fn: string, _a?: unknown) => {
    if (fn === 'crypto_customer_status') return { data: opts.kyc ?? null, error: null };
    const r = opts.rpc?.[fn];
    return { data: r?.data ?? null, error: r?.error ?? null };
  });
  const from = vi.fn((table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'order']) c[m] = () => c;
    const rows = opts.tables?.[table] ?? [];
    c.maybeSingle = async () =>
      table === 'stores'
        ? {
            data: {
              id: 's1',
              module_overrides: opts.module === false ? {} : { 'credit.topup.crypto': true },
            },
            error: null,
          }
        : table === 'crypto_requests'
          ? { data: { status: opts.reqStatus ?? 'open' }, error: null }
          : { data: rows[0] ?? null, error: null };
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(res, rej);
    return c;
  });
  const auth = { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) };
  return { client: { rpc, from, auth } as never, rpc };
}
const ctx = (c: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/customers',
  navigate: () => {},
  client: c as never,
  orgId: 'o1',
  storeId: null,
  homeStoreId: 's1',
  permissions: ['customer.view', 'payment.take'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const mount = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

describe('<CryptoPanel>', () => {
  it('is hidden while the shop has not switched the module on', async () => {
    const { client: c } = client({ module: false });
    mount(<CryptoPanel ctx={ctx(c)} card={CARD} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByRole('region', { name: /Top up Credit with crypto/ })).toBeNull();
  });

  it('asks for KYC first, validates it, and submits a T1 record for approval', async () => {
    const { client: c, rpc } = client({ rpc: { crypto_kyc_submit: { data: 'k1' } } });
    mount(<CryptoPanel ctx={ctx(c)} card={CARD} />);
    await screen.findByText('Identity check (KYC)');
    await userEvent.click(screen.getByRole('button', { name: 'Submit KYC' }));
    expect(await screen.findByText(/Fill everything in/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Nationality'), 'British');
    await userEvent.type(screen.getByLabelText('Passport number'), 'AB1234567');
    await userEvent.click(screen.getByRole('button', { name: 'Submit KYC' }));
    await waitFor(() =>
      expect(rpc.mock.calls.some((x) => x[0] === 'crypto_kyc_submit')).toBe(true),
    );
    const p = (
      rpc.mock.calls.find((x) => x[0] === 'crypto_kyc_submit') as unknown as [
        string,
        { p: Record<string, unknown> },
      ]
    )[1].p;
    expect(p).toMatchObject({
      store_id: 's1',
      customer_id: 'c1',
      tier: 'T1',
      passport_no: 'AB1234567',
      owned_addresses: [],
    });
  });

  it('T2 needs the source of funds and a VALID wallet address (checksum)', async () => {
    const { client: c, rpc } = client({ rpc: { crypto_kyc_submit: { data: 'k1' } } });
    mount(<CryptoPanel ctx={ctx(c)} card={CARD} />);
    await screen.findByText('Identity check (KYC)');
    await userEvent.type(screen.getByLabelText('Nationality'), 'British');
    await userEvent.type(screen.getByLabelText('Passport number'), 'AB1234567');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByLabelText('Source of funds'), 'salary');
    await userEvent.type(
      screen.getByLabelText(/Customer’s own wallet address/),
      TRON.slice(0, -1) + 'u',
    ); // one-letter typo
    await userEvent.click(screen.getByRole('button', { name: 'Submit KYC' }));
    expect(await screen.findByText(/Fill everything in/)).toBeTruthy();
    expect(rpc.mock.calls.some((x) => x[0] === 'crypto_kyc_submit')).toBe(false);
    const addr = screen.getByLabelText(/Customer’s own wallet address/);
    await userEvent.clear(addr);
    await userEvent.type(addr, TRON);
    await userEvent.click(screen.getByRole('button', { name: 'Submit KYC' }));
    await waitFor(() =>
      expect(rpc.mock.calls.some((x) => x[0] === 'crypto_kyc_submit')).toBe(true),
    );
  });

  it('a pending KYC blocks the request form', async () => {
    const { client: c } = client({ kyc: { kyc_id: 'k', tier: 'T1', status: 'pending' } });
    mount(<CryptoPanel ctx={ctx(c)} card={CARD} />);
    expect(await screen.findByText(/waiting for a manager or the owner to approve/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create payment request' })).toBeNull();
  });

  it('with an approved KYC it asks the server for a request and shows the amount, network, 6+6 address, QR and rate', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            request_id: 'r1',
            network: 'tron',
            token_label: 'USDT on TRON (TRC-20)',
            address: TRON,
            units_text: '27.400317',
            thb: 100000,
            rate: 3650,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            qr: TRON,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', f);
    const { client: c } = client({ kyc: { kyc_id: 'k', tier: 'T1', status: 'approved' } });
    mount(<CryptoPanel ctx={ctx(c)} card={CARD} />);
    await userEvent.type(await screen.findByLabelText('Amount to add, in THB'), '1000');
    await userEvent.click(screen.getByRole('button', { name: 'Create payment request' }));
    expect(await screen.findByText('27.400317')).toBeTruthy();
    expect(screen.getByText('USDT on TRON (TRC-20)')).toBeTruthy();
    expect(screen.getByText('TR7NHq')).toBeTruthy(); // first 6, large
    expect(screen.getByText('gjLj6t')).toBeTruthy(); // last 6, large
    expect(screen.getByRole('img', { name: /QR to pay 27.400317/ })).toBeTruthy();
    expect(screen.getByText(/Locked rate: 1 USDT = ฿36.5/)).toBeTruthy();
    const call = f.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(call[0]).toBe('/api/crypto/request');
    expect(call[1].headers.Authorization).toBe('Bearer jwt');
    expect(JSON.parse(call[1].body)).toEqual({
      store_id: 's1',
      customer_id: 'c1',
      network: 'tron',
      thb: 100000,
    });
  });

  it("shows the server's reason when a request is refused", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'refused', problem: 'per_day' }), { status: 422 }),
      ),
    );
    const { client: c } = client({ kyc: { kyc_id: 'k', tier: 'T1', status: 'approved' } });
    mount(<CryptoPanel ctx={ctx(c)} card={CARD} />);
    await userEvent.type(await screen.findByLabelText('Amount to add, in THB'), '1000');
    await userEvent.click(screen.getByRole('button', { name: 'Create payment request' }));
    expect(await screen.findByText('Over the daily limit.')).toBeTruthy();
  });
});

describe('<CryptoPage>', () => {
  const page = (c: unknown, over: Partial<PageContext> = {}) =>
    mount(<CryptoPage ctx={ctx(c, { permissions: ['credit.adjust'], ...over })} />);

  it('refuses people without credit.adjust', () => {
    const { client: c } = client();
    mount(<CryptoPage ctx={ctx(c, { permissions: [] })} />);
    expect(screen.getByText('This account may not manage crypto.')).toBeTruthy();
  });

  it('shows the wallet with the 6+6 ends large and sets a new wallet only with a valid address', async () => {
    const { client: c, rpc } = client({ tables: { stores: [{ id: 's1' }], crypto_wallets: [] } });
    page(c);
    const tron = await screen.findByLabelText('Wallet address (tron)');
    await userEvent.type(tron, TRON.slice(0, -1) + 'u');
    await userEvent.click(screen.getAllByRole('button', { name: 'Set the wallet' })[0]!);
    expect(await screen.findByText(/That address is not valid/)).toBeTruthy();
    await userEvent.clear(tron);
    await userEvent.type(tron, TRON);
    await userEvent.click(screen.getAllByRole('button', { name: 'Set the wallet' })[0]!);
    await waitFor(() =>
      expect(rpc.mock.calls.some((x) => x[0] === 'crypto_set_wallet')).toBe(true),
    );
    const p = (
      rpc.mock.calls.find((x) => x[0] === 'crypto_set_wallet') as unknown as [
        string,
        { p: Record<string, unknown> },
      ]
    )[1].p;
    expect(p).toMatchObject({ network: 'tron', address: TRON });
  });

  it('an existing wallet can only be CHANGED by request, and a pending change can be approved', async () => {
    const { client: c, rpc } = client({
      tables: {
        stores: [{ id: 's1' }],
        crypto_wallets: [{ id: 'w1', network: 'tron', address: TRON, label: null }],
        crypto_wallet_changes: [
          { id: 'ch1', network: 'tron', new_address: 'T' + 'B'.repeat(33), requested_by: 'x' },
        ],
      },
    });
    page(c);
    expect(await screen.findByText('TR7NHq')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve the change' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('crypto_wallet_change_approve', { p_change: 'ch1' }),
    );
  });

  it('approves a KYC with a note', async () => {
    const { client: c, rpc } = client({
      tables: {
        stores: [{ id: 's1' }],
        crypto_kyc: [
          {
            id: 'k1',
            tier: 'T1',
            full_name: 'Anna Smith',
            nationality: 'British',
            passport_no: 'AB1234567',
            contact: 'a@x.test',
            source_of_funds: null,
            created_by: null,
          },
        ],
      },
    });
    page(c);
    await screen.findByText('Anna Smith');
    await userEvent.type(screen.getByLabelText('Note'), 'passport checked');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('crypto_kyc_decide', {
        p_kyc: 'k1',
        p_approve: true,
        p_note: 'passport checked',
      }),
    );
  });

  it('explains a transfer in review and credits it only with a request chosen and a note', async () => {
    const { client: c, rpc } = client({
      tables: {
        stores: [{ id: 's1' }],
        crypto_transfers: [
          {
            id: 'tr1',
            wallet_id: 'w1',
            network: 'tron',
            tx_hash: 'abcdef1234567890abcdef',
            from_address: 'TFromAddress0000000000000000000000',
            amount_units: 20_000_000,
            confirmations: 20,
            reason: 'unmatched',
            block_time: '2026-11-18T03:00:00Z',
          },
        ],
        crypto_requests: [
          {
            id: 'rq1',
            wallet_id: 'w1',
            thb_amount: 100000,
            amount_units: 27_400_317,
            status: 'open',
            created_at: '2026-11-18T02:50:00Z',
          },
        ],
      },
    });
    page(c);
    expect(await screen.findByText('The amount matches no request')).toBeTruthy();
    expect(screen.getByText('20.000000 USDT')).toBeTruthy();
    const credit = screen.getByRole('button', {
      name: 'Credit what was actually received',
    }) as HTMLButtonElement;
    expect(credit.disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Match with request'), 'rq1');
    await userEvent.click(credit);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(rpc.mock.calls.some((x) => x[0] === 'crypto_resolve_review')).toBe(false);
    await userEvent.type(
      screen.getByLabelText('Record of your decision (required)'),
      'customer confirmed',
    );
    await userEvent.click(credit);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('crypto_resolve_review', {
        p_transfer: 'tr1',
        p_action: 'credit',
        p_request: 'rq1',
        p_note: 'customer confirmed',
      }),
    );
  });

  it('exports the AML report as CSV and records the export', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { client: c, rpc } = client({
      tables: { stores: [{ id: 's1' }] },
      rpc: {
        crypto_aml_report: {
          data: [
            {
              credited_at: '2026-11-18T03:00:00Z',
              request_id: 'r',
              customer: 'Anna',
              nationality: 'British',
              passport_last4: '4567',
              tier: 'T1',
              contact: 'a@x',
              network: 'tron',
              token: 'USDT',
              tx_hash: 'abc',
              from_address: 'TF',
              to_address: 'TT',
              units: 27400317,
              thb: 100000,
              rate: 3650,
              flags: [],
            },
          ],
        },
      },
    });
    page(c);
    await userEvent.click(await screen.findByRole('button', { name: 'Export the AML report' }));
    await waitFor(() => expect(rpc.mock.calls.some((x) => x[0] === 'write_audit')).toBe(true));
    const a = (
      rpc.mock.calls.find((x) => x[0] === 'write_audit') as unknown as [
        string,
        Record<string, unknown>,
      ]
    )[1];
    expect(a.p_action).toBe('export.report');
    expect((URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
