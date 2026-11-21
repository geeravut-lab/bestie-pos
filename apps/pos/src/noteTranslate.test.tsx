import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { NoteTranslate } from './NoteTranslate';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = {
  auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
};
const ctx = (on: boolean): PageContext => ({
  path: '/order/1',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: (id) => on && id === 'ai.translate',
});
const wrap = (c: PageContext, text = 'Без кинзы, пожалуйста') =>
  render(
    <I18nProvider initialLang="th">
      <NoteTranslate ctx={c} storeId="s1" text={text} />
    </I18nProvider>,
  );
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });

describe('<NoteTranslate>', () => {
  it('shows nothing while the module is off or the note is empty', () => {
    const { container } = wrap(ctx(false));
    expect(container.textContent).toBe('');
    cleanup();
    expect(wrap(ctx(true), '   ').container.textContent).toBe('');
  });
  it('translates a guest note into the screen’s language with one tap', async () => {
    const f = vi.fn(async () => json({ available: true, text: 'ไม่ใส่ผักชี' }));
    vi.stubGlobal('fetch', f);
    wrap(ctx(true));
    await userEvent.click(screen.getByRole('button', { name: 'แปลโน้ตนี้' }));
    expect(await screen.findByText('ไม่ใส่ผักชี')).toBeTruthy();
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/staff/translate');
    expect(JSON.parse(String(call[1].body))).toEqual({
      store_id: 's1',
      text: 'Без кинзы, пожалуйста',
      to: 'th',
    });
  });
  it('says so when the service is off or fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ available: false })),
    );
    wrap(ctx(true));
    await userEvent.click(screen.getByRole('button', { name: 'แปลโน้ตนี้' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
