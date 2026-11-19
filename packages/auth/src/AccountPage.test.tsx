import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { AuthProvider } from './context';
import { AccountPage } from './components';

vi.mock('./LineConnect', () => ({ LineConnect: () => null }));
afterEach(cleanup);

const LINE_USER = {
  id: 'u1',
  email: 'aivora+zir5hkgeg3zgiahdsob2il7qqd62@bestie-pos.vercel.app',
  app_metadata: { provider: 'aivora', providers: ['email'] },
  user_metadata: { display_name: 'Somchai Jaidee', hub_email: 'real@example.com' },
};

function client(user: Record<string, unknown>, profileName: string | null = null) {
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: { user } } })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { display_name: profileName }, error: null }),
      }),
    }),
  }));
  return { auth, from, rpc: vi.fn() } as never;
}
const mount = (c: never) =>
  render(
    <I18nProvider initialLang="en">
      <AuthProvider client={c}>
        <AccountPage />
      </AuthProvider>
    </I18nProvider>,
  );

describe('<AccountPage> who is signed in', () => {
  it('a LINE (Aivora) account shows the name Aivora sent, not the made-up e-mail, and offers no password form', async () => {
    mount(client(LINE_USER));
    expect(await screen.findByText('Somchai Jaidee')).toBeTruthy();
    expect(screen.queryByText(/aivora\+/)).toBeNull();
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });

  it('without a stored name it uses the profile name, then a plain "LINE account" label', async () => {
    const noName = { ...LINE_USER, user_metadata: {} };
    const { unmount } = mount(client(noName, 'Mali'));
    expect(await screen.findByText('Mali')).toBeTruthy();
    unmount();
    mount(client(noName, null));
    expect(await screen.findByText('LINE (Aivora) account')).toBeTruthy();
    expect(screen.queryByText(/aivora\+/)).toBeNull();
  });

  it('an e-mail account still shows its e-mail and the password form', async () => {
    mount(
      client({
        id: 'u2',
        email: 'owner@example.com',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
      }),
    );
    expect(await screen.findByText('owner@example.com')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Current password')).toBeTruthy());
  });

  it('a Google account shows its e-mail and no password form', async () => {
    mount(
      client({
        id: 'u3',
        email: 'me@gmail.com',
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { display_name: 'Me' },
      }),
    );
    expect(await screen.findByText('me@gmail.com')).toBeTruthy();
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });
});
