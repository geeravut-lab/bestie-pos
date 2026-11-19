import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { TendersPage } from './TendersPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const tables = (overrides: Record<string, boolean> = {}, plan = 'pro') => ({
  stores: [{ id: 's1', name: 'Acme', profile: 'restaurant', plan, module_overrides: overrides }],
  orgs: [{ legal_sign_off: {} }],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/settings/tenders',
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
      <TendersPage ctx={c} />
    </I18nProvider>,
  );
const sw = (name: string) => screen.getByRole('switch', { name }) as HTMLInputElement;

describe('<TendersPage>', () => {
  it('cash is always on; PromptPay on and card off by default; Credit off until the owner chooses', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByRole('heading', { name: 'Payment methods' });
    expect(sw('Cash').checked).toBe(true);
    expect(sw('Cash').disabled).toBe(true);
    expect(sw('Accept PromptPay QR').checked).toBe(true);
    expect(sw('Accept cards & e-wallets').checked).toBe(false);
    expect(sw('Pay with Bestie Credit').checked).toBe(false);
  });

  it('switching card on stores only the difference from the profile default', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Payment methods' });
    await userEvent.click(sw('Accept cards & e-wallets'));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'stores',
      op: 'update',
      values: { module_overrides: { 'tender.gateway': true } },
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('switching PromptPay off is stored as an explicit false', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Payment methods' });
    await userEvent.click(sw('Accept PromptPay QR'));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      values: { module_overrides: { 'tender.promptpay': false } },
    });
  });

  it('is read-only without settings.manage', async () => {
    mount(ctx(fakeDb(tables()).client, { isOwner: false }));
    await screen.findByRole('heading', { name: 'Payment methods' });
    expect(sw('Accept PromptPay QR').disabled).toBe(true);
  });
});
