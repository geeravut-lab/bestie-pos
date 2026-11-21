import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { Lang } from '@bestie/i18n';
import { IslandPage } from './IslandPage';
import { JoinPage } from './JoinPage';
import { PassPage } from './PassPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T = 'a'.repeat(32);
const net = { slug: 'koh-phangan', name: { th: 'เกาะพะงัน', en: 'Koh Phangan' } };
const shops = [
  {
    category: 'spa',
    title: { th: 'สปา', en: 'Palm Spa' },
    about: { en: 'Oil massage' },
    booking_token: 'b'.repeat(32),
  },
  { category: 'food', title: { th: 'ครัว', en: 'Kitchen' }, about: null, booking_token: null },
];
const mount = (ui: React.ReactElement, lang: Lang = 'en') =>
  render(
    <I18nProvider guest initialLang={lang}>
      {ui}
    </I18nProvider>,
  );

describe('<PassPage>', () => {
  it('shows her name, code, points, history and the shops', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              pass: {
                name: 'Liu',
                code: 'BP-ABCD2345KK',
                network: net,
                points: 12,
                activity: [
                  { kind: 'earn', points: 12, at: '2026-11-20T05:00:00Z', shop: 'Cafe Nok' },
                ],
                shops,
              },
            }),
          ),
      ),
    );
    mount(<PassPage token={T} />);
    expect(await screen.findByText('Hello Liu')).toBeTruthy();
    expect(screen.getByText('BP-ABCD2345KK')).toBeTruthy();
    expect(screen.getByText('12', { selector: '.pass-points' })).toBeTruthy();
    expect(screen.getByText(/Earned · Cafe Nok/)).toBeTruthy();
    expect(screen.getByText('Palm Spa')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Book online' }).getAttribute('href')).toBe(
      `/book/${'b'.repeat(32)}`,
    );
  });
  it('says so for an unknown pass and for a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    mount(<PassPage token={T} />);
    expect(await screen.findByText(/pass was not found/i)).toBeTruthy();
    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 502 })),
    );
    mount(<PassPage token={T} />);
    expect(await screen.findByText(/Could not load the pass/i)).toBeTruthy();
  });
  it('speaks German and Hebrew where translated (Hebrew flips the page direction)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    mount(<PassPage token={T} />, 'de');
    expect(await screen.findByText(/Pass wurde nicht gefunden/)).toBeTruthy();
    cleanup();
    mount(<PassPage token={T} />, 'he');
    expect(await screen.findByText(/הכרטיס לא נמצא/)).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
  });
});

describe('<JoinPage>', () => {
  it('needs the consent tick, then registers and offers the pass', async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, token: T, code: 'BP-ABCD2345KK' })),
    );
    vi.stubGlobal('fetch', f);
    mount(<JoinPage slug="koh-phangan" />);
    await userEvent.type(screen.getByLabelText('Name'), 'Liu');
    await userEvent.type(screen.getByLabelText('Phone number'), '081 111 1111');
    await userEvent.click(screen.getByRole('button', { name: 'Create my pass' }));
    expect(await screen.findByText('Please tick the consent box first.')).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Create my pass' }));
    expect(await screen.findByText('Your pass is ready.')).toBeTruthy();
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ slug: 'koh-phangan', name: 'Liu', consent: true });
    expect(screen.getByRole('link', { name: 'Open my pass' }).getAttribute('href')).toBe(
      `/pass/${T}`,
    );
  });
  it('tells her when the number already has a pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'exists' }))),
    );
    mount(<JoinPage slug="koh-phangan" />);
    await userEvent.type(screen.getByLabelText('Name'), 'Liu');
    await userEvent.type(screen.getByLabelText('Phone number'), '0811111111');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Create my pass' }));
    expect(await screen.findByText(/already has a pass/)).toBeTruthy();
  });
});

describe('<IslandPage>', () => {
  it('lists the shops and filters by category', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ island: { network: net, shops } }))),
    );
    mount(<IslandPage slug="koh-phangan" />);
    expect(await screen.findByText('Palm Spa')).toBeTruthy();
    expect(screen.getByText('Kitchen')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Spa' }));
    await waitFor(() => expect(screen.queryByText('Kitchen')).toBeNull());
    expect(screen.getByText('Palm Spa')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Tourist Pass/ }).getAttribute('href')).toBe(
      '/join/koh-phangan',
    );
  });
});
