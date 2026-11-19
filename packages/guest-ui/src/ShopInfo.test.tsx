import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { FeedbackForm, ShopInfo } from './ShopInfo';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const mount = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const CARDS = [
  { id: 'a', title: { th: 'ไวไฟ', en: 'Wifi' }, body: { th: 'รหัส 1234', en: 'Password 1234' } },
  { id: 'b', title: { th: 'เวลาเปิด', en: 'Opening hours' }, body: { th: '8-22', en: '8am-10pm' } },
];
const route = (ask: unknown) =>
  vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.startsWith('/api/guest/info?')) return new Response(JSON.stringify({ info: CARDS }));
    if (u === '/api/guest/info-ask') return new Response(JSON.stringify(ask));
    return new Response('{}');
  });

describe('<ShopInfo>', () => {
  it('lists the shop’s cards in the guest’s language and opens one on tap', async () => {
    vi.stubGlobal('fetch', route({ available: false }));
    mount(<ShopInfo token="t" ai={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Wifi' }));
    expect(screen.getByText('Password 1234')).toBeTruthy();
    expect(screen.queryByLabelText(/Ask about the shop/)).toBeNull(); // no AI box without the module
  });
  it('shows nothing when the shop wrote no cards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ info: [] }))),
    );
    const { container } = mount(<ShopInfo token="t" ai />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
  it('with the assistant on, a question narrows the list to the cards it pointed at, with the shop’s own text', async () => {
    vi.stubGlobal('fetch', route({ available: true, cards: [CARDS[1]] }));
    mount(<ShopInfo token="t" ai />);
    await screen.findByRole('button', { name: 'Wifi' });
    fireEvent.change(screen.getByLabelText(/Ask about the shop/), {
      target: { value: 'when do you open' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('8am-10pm')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wifi' })).toBeNull();
  });
  it('when nothing fits it says so and points to the call button', async () => {
    vi.stubGlobal('fetch', route({ available: true, cards: [] }));
    mount(<ShopInfo token="t" ai />);
    await screen.findByRole('button', { name: 'Wifi' });
    fireEvent.change(screen.getByLabelText(/Ask about the shop/), {
      target: { value: 'parking?' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText(/Press "Call the staff"/)).toBeTruthy();
  });
});

describe('<FeedbackForm>', () => {
  it('needs a rating, sends rating + topic + comment, then thanks', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', f);
    mount(<FeedbackForm token="tok" />);
    const send = screen.getByRole('button', { name: 'Send feedback' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '2 / 5' }));
    await userEvent.selectOptions(screen.getByLabelText('About'), 'service');
    await userEvent.type(screen.getByLabelText(/Anything to add/), 'slow');
    await userEvent.click(send);
    expect(await screen.findByText('Thank you for your feedback')).toBeTruthy();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/guest/feedback');
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'tok',
      rating: 2,
      topic: 'service',
      comment: 'slow',
    });
  });
  it('says so when it cannot send or when sending too often', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 429 })),
    );
    mount(<FeedbackForm token="tok" />);
    await userEvent.click(screen.getByRole('button', { name: '4 / 5' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByText('Too many messages, please try again later')).toBeTruthy();
  });
});
