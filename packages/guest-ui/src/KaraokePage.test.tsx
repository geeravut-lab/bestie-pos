import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { KaraokePage } from './KaraokePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T = 'c'.repeat(32);
const ID = 'dQw4w9WgXcQ';
const view = (over: Record<string, unknown> = {}) => ({
  shop: 'Sing Along',
  room: 'VIP 1',
  songs_enabled: true,
  running: true,
  elapsed_seconds: 125,
  queue: [{ id: 's1', video_id: ID, title: 'First song', status: 'playing' }],
  ...over,
});
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const mount = () =>
  render(
    <I18nProvider guest initialLang="en">
      <KaraokePage token={T} />
    </I18nProvider>,
  );
const bodies = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);

describe('<KaraokePage>', () => {
  it('shows the room, the clock and the queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ room: view() })),
    );
    mount();
    expect(await screen.findByRole('heading', { name: 'Room VIP 1' })).toBeTruthy();
    expect(screen.getByText(/0:02:0\d/)).toBeTruthy();
    expect(screen.getByText('First song')).toBeTruthy();
  });

  it('says the room is not started and offers no search', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ room: view({ running: false, queue: [] }) })),
    );
    mount();
    expect(await screen.findByText(/timer for this room has not started/i)).toBeTruthy();
    expect(screen.queryByLabelText('Type a song or artist')).toBeNull();
  });

  it('says so when the room is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'not_found' }, 404)),
    );
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('searches by typing, lists the real songs and queues one', async () => {
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') return json({ ok: true, id: 'x', title: 'Found Song' });
      if (u.includes('&q='))
        return json({
          available: true,
          songs: [{ videoId: ID, title: 'Found Song', channel: 'Ch' }],
        });
      return json({ room: view({ queue: [] }) });
    });
    vi.stubGlobal('fetch', f);
    mount();
    const box = await screen.findByLabelText('Type a song or artist');
    await userEvent.type(box, 'let it be');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Found Song')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add to the queue' }));
    await waitFor(() => expect(bodies(f).length).toBe(1));
    expect(bodies(f)[0]).toMatchObject({ t: T, link: ID });
    expect(String(bodies(f)[0]!.client_id)).toMatch(/[0-9a-f-]{20,}/);
    expect(await screen.findByText(/Added to the queue/)).toBeTruthy();
  });

  it('adds a pasted YouTube link and shows the queue-full answer', async () => {
    const f = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'POST'
        ? json({ ok: false, error: 'full' })
        : json({ room: view({ queue: [] }) }),
    );
    vi.stubGlobal('fetch', f);
    mount();
    const box = await screen.findByLabelText('Or paste a YouTube link', { selector: 'input' });
    await userEvent.type(box, `https://youtu.be/${ID}`);
    await userEvent.click(screen.getByRole('button', { name: 'Add from the link' }));
    expect(await screen.findByText(/queue is full/i)).toBeTruthy();
    expect(bodies(f)[0]).toMatchObject({ link: `https://youtu.be/${ID}` });
  });

  it('explains when the search is not switched on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('&q=')
          ? json({ available: false, reason: 'no_key', songs: [] })
          : json({ room: view({ queue: [] }) }),
      ),
    );
    mount();
    await userEvent.type(await screen.findByLabelText('Type a song or artist'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Song search is not switched on/)).toBeTruthy();
  });

  it('tells a device without speech recognition to type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ room: view({ queue: [] }) })),
    );
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Say the song name' }));
    expect(await screen.findByText(/cannot search by voice/)).toBeTruthy();
  });

  it('uses the browser’s speech recognition when it exists and searches what it heard', async () => {
    class FakeRecognition {
      lang = '';
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        queueMicrotask(() => {
          this.onresult?.({ results: [[{ transcript: 'yesterday' }]] });
          this.onend?.();
        });
      }
      stop() {}
    }
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const f = vi.fn(async (url: unknown) =>
      String(url).includes('&q=')
        ? json({
            available: true,
            songs: [{ videoId: ID, title: 'Yesterday karaoke', channel: '' }],
          })
        : json({ room: view({ queue: [] }) }),
    );
    vi.stubGlobal('fetch', f);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Say the song name' }));
    expect(await screen.findByText('Yesterday karaoke')).toBeTruthy();
    expect(f.mock.calls.some((c) => String(c[0]).includes('q=yesterday'))).toBe(true);
  });
});
