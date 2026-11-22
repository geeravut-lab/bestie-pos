import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { StoreModuleConfig } from '@bestie/core';
import { AppShell } from './AppShell';
import { ROLE_LAYOUT } from './nav';
import { RoleHome } from './RoleHome';

afterEach(cleanup);

const store = (profile: StoreModuleConfig['profile']): StoreModuleConfig => ({
  profile,
  plan: 'pro',
  moduleOverrides: {},
  legalSignOff: { cryptoTopup: false },
});

const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

describe('<RoleHome>', () => {
  it('renders one illustrated card per role card and greys out modules that are off', () => {
    wrap(<RoleHome role="cashier" ctx={{ store: store('restaurant') }} onNavigate={() => {}} />);
    const cards = screen.getAllByRole('link');
    expect(cards).toHaveLength(ROLE_LAYOUT.cashier.cards.length);
    const queue = cards.find((c) => within(c).queryByText('Queue'))!;
    expect(queue.getAttribute('aria-disabled')).toBe('true'); // restaurant has no queue module
    const sell = cards.find((c) => within(c).queryByText('Sell'))!;
    expect(sell.getAttribute('href')).toBe('/sell');
    expect(sell.querySelector('svg.illustration')).not.toBeNull();
  });

  it('uses an admin-uploaded image instead of the built-in illustration', () => {
    wrap(
      <RoleHome
        role="cashier"
        ctx={{ store: store('cafe') }}
        onNavigate={() => {}}
        imageUrls={{ sell: '/img/sell.png' }}
      />,
    );
    const img = screen.getByRole('img', { name: /Illustration for Sell/ });
    expect(img.getAttribute('src')).toBe('/img/sell.png');
  });

  it('navigates on tap, ignores taps on disabled cards, and shows a spinner on the pending card', async () => {
    const onNavigate = vi.fn();
    const { rerender } = wrap(
      <RoleHome role="cashier" ctx={{ store: store('restaurant') }} onNavigate={onNavigate} />,
    );
    await userEvent.click(screen.getByRole('link', { name: /Sell/ }));
    expect(onNavigate).toHaveBeenCalledWith('/sell');
    await userEvent.click(screen.getByRole('link', { name: /Queue/ }));
    expect(onNavigate).toHaveBeenCalledTimes(1);

    rerender(
      <I18nProvider initialLang="en">
        <RoleHome
          role="cashier"
          ctx={{ store: store('restaurant') }}
          onNavigate={onNavigate}
          pendingPath="/orders"
        />
      </I18nProvider>,
    );
    const orders = screen.getByRole('link', { name: /Orders/ });
    expect(orders.getAttribute('aria-busy')).toBe('true');
    expect(orders.querySelector('.spinner')).not.toBeNull();
    await userEvent.click(orders);
    expect(onNavigate).toHaveBeenCalledTimes(1); // no double navigation while pending
  });
});

describe('<AppShell>', () => {
  const props = {
    role: 'cashier' as const,
    ctx: { store: store('cafe') },
    path: '/',
    onNavigate: () => {},
  };

  it('bottom bar = 2 tabs, raised centre action, 1 tab, More', () => {
    wrap(
      <AppShell {...props}>
        <p>content</p>
      </AppShell>,
    );
    const bar = screen.getByRole('navigation', { name: 'Main menu' });
    expect(bar.className).toContain('bar');
    expect(bar.children).toHaveLength(5);
    expect(within(bar).getByRole('link', { name: /Sell/ }).className).toContain('bar-center');
    expect(within(bar).getByRole('link', { name: /Home/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('shows a progress bar and spinner on the tapped menu item while the next screen loads', () => {
    wrap(
      <AppShell {...props} pendingPath="/orders">
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(document.querySelectorAll('[aria-busy="true"] .spinner').length).toBeGreaterThan(0);
  });

  it('More sheet lists the remaining items, closes with ✕ and Esc, and picking an item closes it', async () => {
    const onNavigate = vi.fn();
    wrap(
      <AppShell {...props} onNavigate={onNavigate}>
        <p>content</p>
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Shift')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Shift/ }));
    expect(onNavigate).toHaveBeenCalledWith('/shift', true); // replaces the entry the sheet reserved
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
