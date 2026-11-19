import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { GuestTablePage } from './GuestTablePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKEN = 'c'.repeat(32);
const MENU = {
  store: { name: 'Acme' },
  table: { name: 'T1' },
  autoSend: false,
  ai: false,
  menu: { categories: [], items: [], groups: [] },
  bill: { order_id: null, lines: [] },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function mount(answer: () => Response) {
  const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/guest/menu')) return json(MENU);
    if (u === '/api/guest/call') return answer();
    return json(null, 404);
  });
  vi.stubGlobal('fetch', f);
  render(
    <I18nProvider initialLang="en">
      <GuestTablePage token={TOKEN} />
    </I18nProvider>,
  );
  return f;
}
const callsMade = (f: ReturnType<typeof mount>) =>
  f.mock.calls
    .filter((c) => String(c[0]) === '/api/guest/call')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));

describe('"call staff" on the guest page', () => {
  it('help and bill are always there; pressing sends a closed reason with the table token and confirms', async () => {
    const f = mount(() => json({ status: 'called' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Call the staff' }));
    expect(await screen.findByText(/The staff have been told/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ask for the bill' }));
    await waitFor(() => expect(callsMade(f)).toHaveLength(2));
    expect(callsMade(f)).toEqual([
      { token: TOKEN, reason: 'help' },
      { token: TOKEN, reason: 'bill' },
    ]);
  });
  it('a second tap while a call is open says they are already on their way', async () => {
    mount(() => json({ status: 'already' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Call the staff' }));
    expect(await screen.findByText(/already know/)).toBeTruthy();
  });
  it('a failure says so plainly — the rest of the page keeps working', async () => {
    mount(() => json({ error: 'server_error' }, 502));
    await userEvent.click(await screen.findByRole('button', { name: 'Call the staff' }));
    expect(await screen.findByText(/Could not reach the staff/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeTruthy();
  });
});
