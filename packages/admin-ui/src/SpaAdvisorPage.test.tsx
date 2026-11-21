import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { SpaAdvisorPage } from './SpaAdvisorPage';

afterEach(cleanup);

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/spa-advisor',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const tables = (signoff: unknown = null) => ({
  menu_items: [
    {
      id: 'm1',
      name: { th: 'นวด', en: 'Oil massage' },
      spa_tags: ['oil_massage'],
      duration_min: 60,
    },
  ],
  stores: [{ spa_rules_signoff: signoff }],
});

describe('<SpaAdvisorPage>', () => {
  it('ticks the types of a service and saves them through the database function', async () => {
    const db = fakeDb(tables());
    wrap(<SpaAdvisorPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Aromatherapy' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_spa_tags')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'save_spa_tags')!.args).toEqual({
      p_item: 'm1',
      p_tags: ['oil_massage', 'aromatherapy'],
    });
  });
  it('the owner records the therapist sign-off; a manager cannot', async () => {
    const db = fakeDb(tables());
    wrap(<SpaAdvisorPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('Not signed yet: guests do not see the advisor.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Name of the therapist who signs'), 'Somchai');
    await userEvent.click(
      screen.getByRole('button', { name: 'Record that a therapist has signed the rules' }),
    );
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'confirm_spa_rules')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'confirm_spa_rules')!.args).toEqual({
      p_store: 's1',
      p_name: 'Somchai',
    });
    cleanup();
    wrap(<SpaAdvisorPage ctx={ctx(db.client, { isOwner: false })} />);
    expect(await screen.findByText('Only the owner records the sign-off.')).toBeTruthy();
  });
  it('shows a current sign-off, and says when it is for an older rules version', async () => {
    wrap(
      <SpaAdvisorPage
        ctx={ctx(
          fakeDb(tables({ name: 'Somchai', at: '2026-11-21T05:00:00Z', version: 1 })).client,
        )}
      />,
    );
    expect(await screen.findByText(/Signed by Somchai/)).toBeTruthy();
    cleanup();
    wrap(
      <SpaAdvisorPage
        ctx={ctx(
          fakeDb(tables({ name: 'Somchai', at: '2026-11-21T05:00:00Z', version: 0 })).client,
        )}
      />,
    );
    expect(await screen.findByText(/older version of the rules/)).toBeTruthy();
  });
  it('prints the rules the therapist must read (every health item with what is avoided and what needs asking)', async () => {
    wrap(<SpaAdvisorPage ctx={ctx(fakeDb(tables()).client)} />);
    await screen.findByText('The rules the therapist must read', { selector: 'h2' });
    expect(screen.getAllByText('Pregnant').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(10);
  });
});
