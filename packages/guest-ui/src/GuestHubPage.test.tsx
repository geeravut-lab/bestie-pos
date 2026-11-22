import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { GuestHubPage, guestHubPages } from './GuestHubPage';

afterEach(cleanup);

describe('the guest role cards', () => {
  it('has a page for each of the four cards and none for other paths', () => {
    for (const path of ['/g/menu', '/g/pass', '/g/book', '/g/pay'])
      expect(guestHubPages({ path, navigate: () => {} })).not.toBeNull();
    expect(guestHubPages({ path: '/g/other', navigate: () => {} })).toBeNull();
    expect(guestHubPages({ path: '/menu', navigate: () => {} })).toBeNull();
  });
  it('explains the way in (a table QR, the island page, the Tourist Pass sign-up)', () => {
    render(
      <I18nProvider guest initialLang="en">
        <GuestHubPage kind="menu" />
        <GuestHubPage kind="pass" />
        <GuestHubPage kind="pay" />
      </I18nProvider>,
    );
    expect(screen.getByText('Order food')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the island shop list' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get a Tourist Pass' })).toBeTruthy();
    expect(screen.getByText('Pay at the table')).toBeTruthy();
  });
});
