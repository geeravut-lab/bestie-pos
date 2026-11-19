import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { AskShopPage } from './AskShopPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = {
  auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
};
const ctx = (over: Partial<PageContext> = {}): PageContext => ({
  path: '/ask',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['report.view'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: () => true,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <AskShopPage ctx={c} />
    </I18nProvider>,
  );
const stub = (status: number, body: unknown) => {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', f);
  return f;
};

describe('<AskShopPage>', () => {
  it('sends the period and the question, shows the answer, the check and the figures', async () => {
    const f = stub(200, {
      available: true,
      answer: 'Sales were 12,000 THB.',
      unverified: [],
      figures: 'Shop: Acme\nSales: 12,000 THB',
      range: { from: '2026-11-13', to: '2026-11-19' },
    });
    mount(ctx());
    await userEvent.selectOptions(screen.getByLabelText('Period'), 'last30');
    await userEvent.click(screen.getByRole('button', { name: 'Which dish sells best?' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Sales were 12,000 THB.')).toBeTruthy();
    expect(
      screen.getByText('Every number in the answer matches your shop’s reports.'),
    ).toBeTruthy();
    expect(screen.getByText(/Sales: 12,000 THB/)).toBeTruthy();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ask/shop');
    expect(JSON.parse(init.body as string)).toEqual({
      store_id: 's1',
      preset: 'last30',
      question: 'Which dish sells best?',
    });
  });

  it('warns loudly when the answer holds a number the reports do not', async () => {
    stub(200, {
      available: true,
      answer: 'Sales were 99,999 THB.',
      unverified: ['99,999'],
      figures: 'x',
      range: { from: 'a', to: 'b' },
    });
    mount(ctx());
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'sales?' } });
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(
      await screen.findByText(/These numbers were not found in your shop’s reports: 99,999/),
    ).toBeTruthy();
    expect(screen.queryByText(/matches your shop’s reports/)).toBeNull();
  });

  it('says so when AI is not set up, and when the server refuses', async () => {
    stub(200, { available: false });
    mount(ctx());
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'sales?' } });
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(/AI is not set up yet/)).toBeTruthy();
    cleanup();
    stub(403, { error: 'forbidden' });
    mount(ctx());
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'sales?' } });
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('is closed to people without report.view and disabled while the module is off', () => {
    mount(ctx({ permissions: [] }));
    expect(screen.getByRole('alert')).toBeTruthy();
    cleanup();
    mount(ctx({ isModuleOn: () => false }));
    expect(screen.getByText(/not switched on for this shop/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'sales?' } });
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
