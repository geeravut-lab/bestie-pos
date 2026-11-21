import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { NetworkPage } from './NetworkPage';

afterEach(cleanup);

const nets = [{ id: 'n1', slug: 'koh-phangan', name: { th: 'เกาะพะงัน', en: 'Koh Phangan' } }];
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/network',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit', 'order.create', 'report.view'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

describe('<NetworkPage>', () => {
  it('lets the owner join, and shows nothing else until then', async () => {
    const db = fakeDb({ networks: nets, network_orgs: [] });
    wrap(<NetworkPage ctx={ctx(db.client)} />);
    expect(
      await screen.findByText('Join a network first to list your shop and issue passes.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'join_network')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'join_network')!.args).toEqual({
      p_org: 'o1',
      p_slug: 'koh-phangan',
      p_join: true,
    });
  });
  it('a manager cannot join', async () => {
    const db = fakeDb({ networks: nets, network_orgs: [] });
    wrap(<NetworkPage ctx={ctx(db.client, { isOwner: false })} />);
    expect(await screen.findByText('Only the business owner can join or leave.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
  });
  it('issues a pass at the counter and shows the clearing statement with what is owed', async () => {
    const db = fakeDb(
      { networks: nets, network_orgs: [{ network_id: 'n1', left_at: null }], network_listings: [] },
      {
        rpc: {
          staff_issue_pass: { data: { token: 'a'.repeat(32), code: 'BP-ABCD2345KK', name: 'Liu' } },
          network_clearing: {
            data: [
              {
                issuer_org: 'o2',
                issuer_name: 'Spa Co',
                redeemer_org: 'o1',
                redeemer_name: 'Cafe Co',
                points: 40,
                amount: 4000,
              },
              {
                issuer_org: 'o1',
                issuer_name: 'Cafe Co',
                redeemer_org: 'o3',
                redeemer_name: 'Shop Co',
                points: 10,
                amount: 1000,
              },
            ],
          },
        },
      },
    );
    wrap(<NetworkPage ctx={ctx(db.client)} />);
    await userEvent.type(await screen.findByLabelText('Guest name'), 'Liu');
    await userEvent.type(screen.getByLabelText('Phone number'), '0811111111');
    await userEvent.click(screen.getByRole('button', { name: 'Issue the pass' }));
    expect(await screen.findByText('BP-ABCD2345KK')).toBeTruthy();
    expect(db.rpcs.find((r) => r.fn === 'staff_issue_pass')!.args).toMatchObject({
      p: { store_id: 's1', name: 'Liu', phone: '0811111111' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Show statement' }));
    expect(await screen.findByText('Spa Co')).toBeTruthy();
    expect(screen.getByText(/Owed to us/).textContent).toContain('฿10');
    expect(screen.getByText(/We owe/).textContent).toContain('฿40');
  });
});
