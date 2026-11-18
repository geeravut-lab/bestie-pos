import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_EVENTS, AUDIT_GROUPS, auditEventLabelKey, auditGroupLabelKey } from '@bestie/core';
import { I18nProvider, dict } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { AuditPage } from './AuditPage';

afterEach(cleanup);

describe('audit labels', () => {
  it('every event and group has a label in both languages', () => {
    for (const lang of ['th', 'en'] as const) {
      const d = dict[lang] as Record<string, string>;
      for (const e of AUDIT_EVENTS)
        expect(d[auditEventLabelKey(e.id)], `${lang}:${e.id}`).toBeTruthy();
      for (const g of AUDIT_GROUPS) expect(d[auditGroupLabelKey(g)], `${lang}:${g}`).toBeTruthy();
    }
  });
});

/** Minimal chainable stand-in for the Supabase query builder. */
function fakeClient(
  opts: {
    settings?: { enabled: boolean; disabled_events: string[] } | null;
    log?: unknown[];
    rpcError?: { code: string } | null;
  } = {},
) {
  const rpc = vi.fn(async () => ({ data: null, error: opts.rpcError ?? null }));
  const from = vi.fn((table: string) => {
    const result =
      table === 'audit_settings'
        ? { data: opts.settings ?? null, error: null }
        : { data: opts.log ?? [], error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'like', 'gte', 'lt']) chain[m] = () => chain;
    chain.limit = async () => result;
    chain.maybeSingle = async () => result;
    return chain;
  });
  // Realtime stand-in: subscribing reports "SUBSCRIBED" at once; nothing is ever pushed in these tests.
  const channel = vi.fn(() => {
    const ch: Record<string, unknown> = {};
    ch.on = () => ch;
    ch.subscribe = (cb?: (s: string) => void) => {
      cb?.('SUBSCRIBED');
      return ch;
    };
    return ch;
  });
  const removeChannel = vi.fn(async () => 'ok');
  return { client: { from, rpc, channel, removeChannel } as never, rpc, from, channel };
}

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/admin/audit',
  navigate: () => {},
  client: client as never,
  orgId: 'org-1',
  storeId: null,
  permissions: ['audit.view', 'settings.manage'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});

const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <AuditPage ctx={c} />
    </I18nProvider>,
  );

describe('<AuditPage> history', () => {
  it('lists events with readable labels, role, source and a lock on critical events', async () => {
    const { client } = fakeClient({
      log: [
        {
          id: 2,
          action: 'payment.refund',
          actor_id: 'abcdef12-0000',
          actor_role: 'owner',
          entity: 'payment',
          entity_id: 'p-1',
          detail: { amount: 10000 },
          source: 'app',
          created_at: '2026-11-17T18:30:00Z',
        },
        {
          id: 1,
          action: 'order.discount',
          actor_id: null,
          actor_role: null,
          entity: 'order',
          entity_id: 'o-1',
          detail: {},
          source: 'db',
          created_at: '2026-11-17T10:00:00Z',
        },
      ],
    });
    mount(ctx(client));
    expect(await screen.findByText('Refund')).toBeTruthy();
    expect(screen.getByText('Discount given')).toBeTruthy();
    expect(screen.getByText('amount=10000')).toBeTruthy();
    expect(screen.getByText(/#abcdef12/)).toBeTruthy();
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByTitle('Always recorded')).toBeTruthy(); // lock on the refund only
    expect(screen.getAllByTitle('Always recorded')).toHaveLength(1);
  });

  it('listens to the org audit topic on a private channel so new events appear without refresh', async () => {
    const { client, channel } = fakeClient();
    mount(ctx(client));
    await screen.findByText('No records yet');
    expect(channel).toHaveBeenCalledWith('audit:org-1', { config: { private: true } });
  });

  it('shows the empty state', async () => {
    mount(ctx(fakeClient().client));
    expect(await screen.findByText('No records yet')).toBeTruthy();
  });

  it('blocks people without audit permission', () => {
    mount(ctx(fakeClient().client, { permissions: ['order.create'] }));
    expect(screen.getByRole('alert').textContent).toContain('permission');
  });
});

describe('<AuditPage> settings', () => {
  const open = async (c: PageContext) => {
    mount(c);
    await userEvent.click(await screen.findByRole('tab', { name: 'Recording settings' }));
    return screen.findByRole('switch');
  };

  it('critical events are ticked, locked and labelled "Always recorded"', async () => {
    await open(ctx(fakeClient().client));
    const refund = screen.getByRole('checkbox', { name: /Refund/ }) as HTMLInputElement;
    expect(refund.checked).toBe(true);
    expect(refund.disabled).toBe(true);
    const discount = screen.getByRole('checkbox', { name: /Discount given/ }) as HTMLInputElement;
    expect(discount.checked).toBe(true);
    expect(discount.disabled).toBe(false);
  });

  it('unticking an event type and saving sends only the unticked ordinary events', async () => {
    const { client, rpc } = fakeClient();
    await open(ctx(client));
    await userEvent.click(screen.getByRole('checkbox', { name: /Discount given/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_audit_settings', {
        p_org: 'org-1',
        p_enabled: true,
        p_disabled: ['order.discount'],
      }),
    );
    expect(await screen.findByText('Settings saved')).toBeTruthy();
  });

  it('master switch off is saved and explains that critical events still record', async () => {
    const { client, rpc } = fakeClient();
    const sw = await open(ctx(client));
    await userEvent.click(sw);
    expect(screen.getByText(/critical events are still always recorded/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_audit_settings', {
        p_org: 'org-1',
        p_enabled: false,
        p_disabled: [],
      }),
    );
  });

  it('"select whole category" unticks ordinary events but keeps critical ones locked on', async () => {
    const { client, rpc } = fakeClient();
    await open(ctx(client));
    const group = screen.getByRole('group', { name: 'Orders' });
    await userEvent.click(within(group).getByRole('button', { name: 'Select whole category' }));
    expect(
      (screen.getByRole('checkbox', { name: /Discount given/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: /Order voided/ }) as HTMLInputElement).checked,
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_audit_settings', {
        p_org: 'org-1',
        p_enabled: true,
        p_disabled: ['order.discount', 'order.price_override', 'order.reopen'],
      }),
    );
  });

  it('loads the stored switches (only the unticked types are stored)', async () => {
    await open(
      ctx(
        fakeClient({
          settings: { enabled: false, disabled_events: ['order.reopen', 'order.void'] },
        }).client,
      ),
    );
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: /Closed bill reopened/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: /Order voided/ }) as HTMLInputElement).checked,
    ).toBe(true); // a stored critical id is ignored
  });

  it('is read-only without the settings permission', async () => {
    const sw = (await open(
      ctx(fakeClient().client, { permissions: ['audit.view'] }),
    )) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect(screen.getByText(/View only/)).toBeTruthy();
  });

  it('shows a readable error when the server refuses', async () => {
    const { client } = fakeClient({ rpcError: { code: '42501' } });
    await open(ctx(client));
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain('permission');
  });
});
