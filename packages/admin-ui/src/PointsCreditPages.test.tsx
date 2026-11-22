import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { CreditPage } from './CreditPage';
import { fakeDb } from './fakeDb';
import { PointsPage } from './PointsPage';

afterEach(cleanup);

const mount = (
  ui: (ctx: PageContext) => React.ReactNode,
  rpc: Record<string, { data?: unknown; error?: { code: string } | null }> = {},
  over: Partial<PageContext> = {},
) => {
  const db = fakeDb({}, { rpc });
  Object.assign(db.client as object, {
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  });
  const ctx = {
    path: '/points',
    navigate: vi.fn(),
    client: db.client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: [],
    isOwner: true,
    isPlatformAdmin: false,
    isModuleOn: () => false,
    ...over,
  } as PageContext;
  render(<I18nProvider initialLang="en">{ui(ctx)}</I18nProvider>);
  return db;
};

describe('<PointsPage>', () => {
  it('shows what customers hold, the biggest balances and the latest movements', async () => {
    mount((ctx) => <PointsPage ctx={ctx} />, {
      points_overview: {
        data: {
          outstanding: 1500,
          earned_30d: 400,
          redeemed_30d: 120,
          members: 7,
          top: [{ customer_id: 'c1', name: 'Noi', balance: 900 }],
          recent: [{ kind: 'earn', points: 40, at: '2026-11-20T05:00:00Z', name: 'Noi' }],
        },
      },
    });
    expect(await screen.findByText('Noi', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('1,500')).toBeTruthy();
    expect(screen.getByText('+40')).toBeTruthy();
  });
  it('asks nothing of a person without the right', async () => {
    const db = mount((ctx) => <PointsPage ctx={ctx} />, {}, { isOwner: false, permissions: [] });
    expect(await screen.findByText(/not allowed|permission/i)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });
});

describe('<CreditPage>', () => {
  it('says plainly that Credit is a liability and that the module is off', async () => {
    mount((ctx) => <CreditPage ctx={ctx} />, { credit_liability_detail: { data: [] } });
    expect(await screen.findByText(/liability of the company/)).toBeTruthy();
    expect(screen.getByText(/not switched on in this shop/)).toBeTruthy();
  });
});
