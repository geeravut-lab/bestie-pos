import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { AiUsagePage, monthRange } from './AiUsagePage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const summary = (rows: unknown[] = []) => ({
  usd_thb: 36,
  prices: {},
  rows,
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/ai/usage',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: [],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <AiUsagePage ctx={c} />
    </I18nProvider>,
  );

describe('monthRange', () => {
  it('first and last day of a month, leap years included', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('<AiUsagePage>', () => {
  it('asks for the owner’s own org for the chosen month and shows calls, tokens and an estimated cost per task', async () => {
    const db = fakeDb(
      {},
      {
        rpc: {
          ai_usage_summary: {
            data: summary([
              {
                task: 'guest_menu_qa',
                model: 'claude-haiku-5-5',
                calls: 100,
                input_tokens: 40000,
                output_tokens: 6000,
                source: 'guest',
              },
              {
                task: 'menu_tags',
                model: 'mystery-model',
                calls: 2,
                input_tokens: 100,
                output_tokens: 50,
                source: 'staff',
              },
            ]),
          },
        },
      },
    );
    mount(ctx(db.client));
    expect(await screen.findByText('Guest menu Q&A')).toBeTruthy();
    expect(screen.getAllByText('100').length).toBeGreaterThan(0);
    expect(screen.getByText('No price yet')).toBeTruthy(); // an unknown model is never shown as free
    const call = db.rpcs.find((r) => r.fn === 'ai_usage_summary')!;
    expect(call.args).toMatchObject({ p_org: 'o1' });
    expect(String((call.args as { p_from: string }).p_from)).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('the platform admin asks for everybody (null org)', async () => {
    const db = fakeDb(
      {},
      {
        rpc: {
          ai_usage_summary: {
            data: summary([
              {
                org_name: 'Acme',
                task: 'menu_tags',
                model: 'claude-haiku-5-5',
                calls: 1,
                input_tokens: 10,
                output_tokens: 10,
              },
            ]),
          },
        },
      },
    );
    mount(ctx(db.client, { isOwner: false, isPlatformAdmin: true }));
    expect(await screen.findByText(/Acme · /)).toBeTruthy();
    expect(db.rpcs[0]!.args).toMatchObject({ p_org: null });
  });

  it('changing the month asks again; an empty month says so', async () => {
    const db = fakeDb({}, { rpc: { ai_usage_summary: { data: summary() } } });
    mount(ctx(db.client));
    expect(await screen.findByText('No AI use this month')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-10' } });
    await waitFor(() =>
      expect(db.rpcs.some((r) => (r.args as { p_from: string }).p_from === '2026-10-01')).toBe(
        true,
      ),
    );
  });

  it('nobody without report.view, owner or platform-admin rights sees it', async () => {
    mount(ctx(fakeDb({}).client, { isOwner: false }));
    expect(await screen.findByText(/not allowed|permission|forbidden/i)).toBeTruthy();
  });
});
