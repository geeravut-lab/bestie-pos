import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { GuestTablePage } from './GuestTablePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKEN = 'b'.repeat(32);
const item = (
  id: string,
  en: string,
  extra: Record<string, unknown> = {},
  price = 10000,
): Record<string, unknown> => ({
  id,
  category_id: 'c1',
  name: { th: en, en },
  price,
  group_ids: [],
  tags: [],
  spice_level: null,
  verified: false,
  highlight: false,
  ...extra,
});
const body = (ai: boolean) => ({
  store: { name: 'Acme' },
  table: { name: 'T1' },
  autoSend: false,
  ai,
  menu: {
    categories: [{ id: 'c1', name: { th: 'จาน', en: 'Mains' } }],
    items: [
      item('1', 'Garlic pork', { tags: ['contains_pork'], spice_level: 1, verified: true }),
      item('2', 'Green curry', {
        tags: ['contains_chicken'],
        spice_level: 2,
        verified: true,
        highlight: true,
      }),
      item('3', 'Plain rice', { verified: true, spice_level: 0 }),
      item('4', 'New special', {}),
      item('5', 'Steak', { verified: true, spice_level: 0 }, 60000),
    ],
    groups: [],
  },
  bill: { order_id: null, lines: [] },
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function mount(ai: boolean, aiAnswer?: () => Response) {
  const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/guest/menu')) return json(body(ai));
    if (u === '/api/guest/ai') return aiAnswer ? aiAnswer() : json({ available: false });
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
const names = () => screen.queryAllByRole('button').map((b) => b.textContent ?? '');
const dish = (n: string) => names().some((t) => t.includes(n));

describe('food filter on the guest page', () => {
  it('shows the shop’s facts on each dish and a recommended badge', async () => {
    mount(false);
    await screen.findByText('Garlic pork', { exact: false });
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByText(/Contains pork/)).toBeTruthy();
    expect(screen.getByText(/Spice 2\/3/)).toBeTruthy();
  });

  it('“No pork” hides the pork dish, parks the unconfirmed dish under a warning, and says how many are hidden', async () => {
    mount(false);
    await screen.findByText('Garlic pork', { exact: false });
    await userEvent.click(screen.getByRole('button', { name: 'No pork' }));
    expect(dish('Garlic pork')).toBe(false);
    expect(dish('Green curry')).toBe(true);
    expect(dish('Plain rice')).toBe(true);
    expect(screen.getByText(/has not confirmed these dishes/)).toBeTruthy();
    expect(screen.getByText(/According to the shop's information/)).toBeTruthy();
    // New special is shown only AFTER the warning, never among the confirmed ones
    const warn = screen.getByText(/has not confirmed these dishes/);
    const lists = document.querySelectorAll('.guest-items');
    expect(lists.length).toBe(2);
    expect(within(lists[0] as HTMLElement).queryByText('New special')).toBeNull();
    expect(within(lists[1] as HTMLElement).getByText('New special')).toBeTruthy();
    expect(warn.compareDocumentPosition(lists[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('1 dishes hidden because they do not match')).toBeTruthy();
  });

  it('“Not spicy” keeps only spice 0; clearing brings everything back', async () => {
    mount(false);
    await screen.findByText('Garlic pork', { exact: false });
    await userEvent.click(screen.getByRole('button', { name: 'Not spicy' }));
    expect(dish('Plain rice')).toBe(true);
    expect(dish('Green curry')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(dish('Green curry')).toBe(true);
    expect(dish('New special')).toBe(true);
  });

  it('with no AI switched on there is no assistant box, and the buttons still work', async () => {
    mount(false);
    await screen.findByText('Garlic pork', { exact: false });
    expect(screen.queryByLabelText('Message to the assistant')).toBeNull();
  });

  it('with the assistant on, the guest’s words fill the same buttons (budget included)', async () => {
    const f = mount(true, () =>
      json({
        available: true,
        understood: true,
        filter: {
          exclude: ['contains_pork'],
          require: [],
          maxSpice: 0,
          maxPrice: 30000,
          keywords: [],
        },
      }),
    );
    await screen.findByText('Garlic pork', { exact: false });
    await userEvent.type(
      screen.getByLabelText('Message to the assistant'),
      'no pork, not spicy, under 300',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'No pork' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(screen.getByRole('button', { name: 'Not spicy' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: /Up to/ })).toBeTruthy();
    expect(dish('Steak')).toBe(false); // over budget
    expect(dish('Plain rice')).toBe(true);
    const call = f.mock.calls.find((c) => String(c[0]) === '/api/guest/ai')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      t: TOKEN,
      text: 'no pork, not spicy, under 300',
    });
  });

  it('when the assistant fails the guest is told to use the buttons — nothing breaks', async () => {
    mount(true, () => json({ error: 'ai_failed' }, 502));
    await screen.findByText('Garlic pork', { exact: false });
    await userEvent.type(screen.getByLabelText('Message to the assistant'), 'vegetarian please');
    await userEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(await screen.findByText(/not available right now/)).toBeTruthy();
    expect(dish('Garlic pork')).toBe(true);
  });
});
