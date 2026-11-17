import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LANG_STORAGE_KEY } from './dict';
import { I18nProvider, useI18n } from './provider';

function Probe() {
  const { lang, t, setLang } = useI18n();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="tagline">{t.appTagline}</span>
      <button onClick={() => setLang('en')}>en</button>
    </div>
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('I18nProvider', () => {
  it('defaults to Thai and sets <html lang>', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('lang').textContent).toBe('th');
    expect(document.documentElement.lang).toBe('th');
  });

  it('switches language, persists it and updates <html lang>', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    act(() => screen.getByText('en').click());
    expect(screen.getByTestId('lang').textContent).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
  });

  it('restores the stored language and ignores garbage', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'en');
    const { unmount } = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('lang').textContent).toBe('en');
    unmount();
    localStorage.setItem(LANG_STORAGE_KEY, 'xx');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('lang').textContent).toBe('th');
  });

  it('throws when used outside a provider', () => {
    expect(() => render(<Probe />)).toThrow(/I18nProvider/);
  });
});
