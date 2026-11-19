import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { Membership } from './myContext';
import { RoleChip } from './AuthApp';

afterEach(cleanup);
const m = (over: Partial<Membership> = {}): Membership => ({
  staffId: 's1',
  orgId: 'o1',
  orgName: 'Group',
  storeId: null,
  displayName: 'Demo',
  roleBuiltIn: 'cashier',
  roleName: 'Cashier',
  permissions: [],
  hiddenModules: [],
  legalSignOff: { cryptoTopup: false },
  ...over,
});
const mount = (lang: 'th' | 'en', props: React.ComponentProps<typeof RoleChip>) =>
  render(
    <I18nProvider initialLang={lang}>
      <RoleChip {...props} />
    </I18nProvider>,
  );

describe('<RoleChip> (the top bar always says who works in which role)', () => {
  it('shows the role in the interface language and the shop', () => {
    mount('en', { membership: m(), place: 'Breeze Café', platformAdmin: false });
    expect(screen.getByText('Cashier')).toBeTruthy();
    expect(screen.getByText('Breeze Café')).toBeTruthy();
    expect(screen.getByLabelText('Role in use: Cashier · Breeze Café')).toBeTruthy();
  });
  it('Thai role names in Thai', () => {
    mount('th', {
      membership: m({ roleBuiltIn: 'owner', roleName: 'Owner' }),
      place: 'กลุ่ม',
      platformAdmin: false,
    });
    expect(screen.getByText('เจ้าของร้าน')).toBeTruthy();
  });
  it('a role the shop made itself shows under its own name; a platform administrator says so', () => {
    mount('en', {
      membership: m({ roleBuiltIn: null, roleName: 'Stock keeper' }),
      place: 'Group',
      platformAdmin: true,
    });
    expect(
      screen.getByLabelText('Role in use: Stock keeper · Group · Platform administrator'),
    ).toBeTruthy();
  });
});
