import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { PassPage } from './PassPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const T = 'a'.repeat(32);
const pass = {
  name: 'Liu',
  code: 'BP-ABCD2345KK',
  network: { slug: 'koh', name: { th: 'เกาะ', en: 'Koh Phangan' } },
  points: 12,
  activity: [],
  shops: [],
};
function stub(wallet: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) =>
      String(url).includes('pass-wallet')
        ? new Response(JSON.stringify(wallet))
        : new Response(JSON.stringify({ pass })),
    ),
  );
}
const mount = () =>
  render(
    <I18nProvider guest initialLang="en">
      <PassPage token={T} />
    </I18nProvider>,
  );

describe('the Tourist Pass card', () => {
  it('prints a credit-card-size card with the network, name, code and QR', async () => {
    stub({ available: false });
    let printed = '';
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      printed = document.getElementById('print-root')?.textContent ?? '';
      expect(document.getElementById('print-root')?.querySelector('svg')).toBeTruthy();
      expect(document.getElementById('print-root')?.querySelector('style')?.textContent).toContain(
        '85.6mm 54mm',
      );
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Print my card/ }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(printed).toContain('Koh Phangan');
    expect(printed).toContain('Liu');
    expect(printed).toContain('BP-ABCD2345KK');
  });
  it('offers Add to Google Wallet only when the server says it is set up', async () => {
    stub({ available: true, url: 'https://pay.google.com/gp/v/save/abc.def.ghi' });
    mount();
    const link = await screen.findByRole('link', { name: 'Add to Google Wallet' });
    expect(link.getAttribute('href')).toBe('https://pay.google.com/gp/v/save/abc.def.ghi');
    cleanup();
    stub({ available: false });
    mount();
    await screen.findByText('Hello Liu');
    expect(screen.queryByRole('link', { name: 'Add to Google Wallet' })).toBeNull();
  });
  it("never follows a wallet link that is not Google's", async () => {
    stub({ available: true, url: 'https://evil.example/save/x' });
    mount();
    await screen.findByText('Hello Liu');
    expect(screen.queryByRole('link', { name: 'Add to Google Wallet' })).toBeNull();
  });
});
