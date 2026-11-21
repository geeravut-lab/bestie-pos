import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { explainShift } from './aiApi';
import { TranslatePage } from './TranslatePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = {
  auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
};
const ctx: PageContext = {
  path: '/translate',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create'],
  isOwner: false,
  isPlatformAdmin: false,
};
const wrap = () =>
  render(
    <I18nProvider initialLang="en">
      <TranslatePage ctx={ctx} />
    </I18nProvider>,
  );
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });

describe('<TranslatePage>', () => {
  it('sends the text with the chosen language and shows the draft', async () => {
    const f = vi.fn(async () => json({ available: true, text: 'ไม่ใส่ผักชี' }));
    vi.stubGlobal('fetch', f);
    wrap();
    await userEvent.type(screen.getByLabelText('Message'), 'No coriander');
    await userEvent.selectOptions(screen.getByLabelText('Translate into'), 'th');
    await userEvent.click(screen.getByRole('button', { name: 'Translate' }));
    expect(await screen.findByText('ไม่ใส่ผักชี')).toBeTruthy();
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/staff/translate');
    expect(JSON.parse(String(call[1].body))).toEqual({
      store_id: 's1',
      text: 'No coriander',
      to: 'th',
    });
    expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('says so when translation is not switched on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ available: false })),
    );
    wrap();
    await userEvent.type(screen.getByLabelText('Message'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Translate' }));
    expect(await screen.findByText(/Translation is not switched on/)).toBeTruthy();
  });

  it('shows the permission error and refuses a text over 600 characters without calling the server', async () => {
    const f = vi.fn(async () => json({ error: 'forbidden' }, 403));
    vi.stubGlobal('fetch', f);
    wrap();
    await userEvent.type(screen.getByLabelText('Message'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Translate' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    cleanup();
    const g = vi.fn(async () => json({ available: true, text: 'x' }));
    vi.stubGlobal('fetch', g);
    wrap();
    const box = screen.getByLabelText('Message');
    await userEvent.click(box);
    await userEvent.paste('x'.repeat(650));
    await userEvent.click(screen.getByRole('button', { name: 'Translate' }));
    expect(await screen.findByText(/longer than 600/)).toBeTruthy();
    expect(g).not.toHaveBeenCalled();
  });
});

describe('explainShift', () => {
  it('returns the summary with the numbers it could not verify', async () => {
    const f = vi.fn(async () =>
      json({
        available: true,
        summary: 'Sales were 100.',
        unverified: ['999'],
        figures: 'Bills: 2',
      }),
    );
    const r = await explainShift(client as never, 'sh1', f as never);
    expect(r).toEqual({
      available: true,
      summary: 'Sales were 100.',
      unverified: ['999'],
      figures: 'Bills: 2',
    });
    expect(
      JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toEqual({ shift_id: 'sh1' });
  });
  it('is unavailable without a key and throws for a forbidden person', async () => {
    expect(
      await explainShift(client as never, 's', (async () => json({ available: false })) as never),
    ).toEqual({ available: false });
    await expect(
      explainShift(client as never, 's', (async () => json({}, 403)) as never),
    ).rejects.toMatchObject({ code: 'err_forbidden' });
  });
});
