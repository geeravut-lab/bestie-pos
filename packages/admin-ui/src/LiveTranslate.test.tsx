import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { LiveTranslate } from './LiveTranslate';

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
      <LiveTranslate ctx={ctx} storeId="s1" />
    </I18nProvider>,
  );
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });

/** A browser with speech recognition that "hears" `words` in the language it was started with. */
function fakeBrowser(words: string) {
  const started: string[] = [];
  class Rec {
    lang = '';
    interimResults = false;
    continuous = false;
    maxAlternatives = 1;
    onresult: ((e: { results: { transcript: string }[][] }) => void) | null = null;
    onerror: (() => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      started.push(this.lang);
      setTimeout(() => {
        if (words) this.onresult?.({ results: [[{ transcript: words }]] });
        this.onend?.();
      }, 0);
    }
    stop() {
      this.onend?.();
    }
  }
  const spoken: { text: string; lang: string }[] = [];
  class Utter {
    lang = '';
    constructor(public text: string) {}
  }
  vi.stubGlobal('webkitSpeechRecognition', Rec);
  vi.stubGlobal('SpeechSynthesisUtterance', Utter);
  vi.stubGlobal('speechSynthesis', {
    cancel: () => {},
    speak: (u: Utter) => spoken.push({ text: u.text, lang: u.lang }),
  });
  return { started, spoken };
}

describe('<LiveTranslate>', () => {
  it('"I speak" listens in my language, translates into theirs, shows it and reads it aloud', async () => {
    const b = fakeBrowser('ขอบคุณค่ะ');
    const f = vi.fn(async () => json({ available: true, text: 'Thank you' }));
    vi.stubGlobal('fetch', f);
    wrap();
    await userEvent.click(screen.getByRole('button', { name: 'I speak' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    expect(b.started).toEqual(['th-TH']);
    expect(
      JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toEqual({ store_id: 's1', text: 'ขอบคุณค่ะ', to: 'en' });
    expect(b.spoken).toEqual([{ text: 'Thank you', lang: 'en-US' }]);
  });

  it('"They speak" listens in their language and shows the translation without reading it aloud', async () => {
    const b = fakeBrowser('Where is the beach?');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ available: true, text: 'หาดอยู่ที่ไหน' })),
    );
    wrap();
    await userEvent.selectOptions(screen.getByLabelText('The guest’s language'), 'ru');
    await userEvent.click(screen.getByRole('button', { name: 'They speak' }));
    expect(await screen.findByText('หาดอยู่ที่ไหน')).toBeTruthy();
    expect(b.started).toEqual(['ru-RU']);
    expect(b.spoken).toEqual([]);
  });

  it('can be told not to read aloud', async () => {
    const b = fakeBrowser('hello');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ available: true, text: 'สวัสดี' })),
    );
    wrap();
    await userEvent.click(screen.getByLabelText('Read my translation aloud to the guest'));
    await userEvent.click(screen.getByRole('button', { name: 'I speak' }));
    await screen.findByText('สวัสดี');
    expect(b.spoken).toEqual([]);
  });

  it('says so when nothing was heard, and never calls the translator', async () => {
    fakeBrowser('');
    const f = vi.fn(async () => json({ available: true, text: 'x' }));
    vi.stubGlobal('fetch', f);
    wrap();
    await userEvent.click(screen.getByRole('button', { name: 'I speak' }));
    expect(await screen.findByText(/Nothing was heard/)).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
  });

  it('tells the person when translation is off or fails', async () => {
    fakeBrowser('hi');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ available: false })),
    );
    wrap();
    await userEvent.click(screen.getByRole('button', { name: 'I speak' }));
    expect(await screen.findByText(/Translation is not switched on/)).toBeTruthy();
    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 500)),
    );
    wrap();
    await userEvent.click(screen.getByRole('button', { name: 'I speak' }));
    await waitFor(() =>
      expect(
        screen.getAllByRole('alert').length + screen.getAllByText(/failed|wrong|unknown/i).length,
      ).toBeGreaterThan(0),
    );
  });

  it('explains when the browser cannot recognise speech', () => {
    wrap();
    expect(screen.getByText(/no speech recognition/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I speak' })).toBeNull();
  });
});
