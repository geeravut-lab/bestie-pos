import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { AuthProvider } from './context';
import { LoginPage, SsoCallbackPage } from './components';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const env = {
  supabaseUrl: 'https://x.supabase.co',
  supabaseAnonKey: 'k',
  siteUrl: 'https://bestie-pos.vercel.app',
};

function fakeClient(over: Record<string, unknown> = {}) {
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: null } })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
    signInWithPassword: vi.fn(async () => ({ error: { code: 'invalid_credentials' } })),
    signUp: vi.fn(async () => ({ data: { session: null }, error: null })),
    signInWithOAuth: vi.fn(async () => ({ error: null })),
    setSession: vi.fn(async () => ({ data: { session: { user: { id: 'u1' } } }, error: null })),
    ...over,
  };
  return { auth, rpc: vi.fn(), from: vi.fn() } as never;
}

const mount = (ui: React.ReactNode, client = fakeClient()) =>
  render(
    <I18nProvider initialLang="en">
      <AuthProvider client={client}>{ui}</AuthProvider>
    </I18nProvider>,
  );

describe('<LoginPage>', () => {
  it('shows a readable error for wrong credentials and a spinner while signing in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ external: { google: false } }))),
    );
    mount(<LoginPage env={env} />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Wrong email or password');
    expect(document.querySelector('.spinner')).toBeNull(); // spinner cleared when done
  });

  it('hides the LINE and Google buttons unless they are configured / enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ external: { google: false } }))),
    );
    mount(<LoginPage env={env} />);
    expect(screen.queryByText(/LINE/)).toBeNull();
    expect(screen.queryByText(/Google/)).toBeNull();
  });

  it('shows LINE when the app slug is set and Google when Supabase has it enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ external: { google: true } }))),
    );
    mount(
      <LoginPage
        env={{ ...env, aivora: { hubUrl: 'https://hub.example', appSlug: 'bestie-pos' } }}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    const line = screen.getByRole('link', { name: /LINE/ });
    expect(line.getAttribute('href')).toContain('app=bestie-pos');
  });

  it('sign up asks to confirm the e-mail when no session comes back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ external: {} }))),
    );
    mount(<LoginPage env={env} />);
    await userEvent.click(screen.getByRole('button', { name: /Sign up/ }));
    await userEvent.type(screen.getByLabelText('Email'), 'new@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'long-enough-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect((await screen.findByRole('status')).textContent).toContain('confirmation link');
  });

  it('rejects a weak password before calling the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ external: {} }))),
    );
    const client = fakeClient();
    mount(<LoginPage env={env} />, client);
    await userEvent.click(screen.getByRole('button', { name: /Sign up/ }));
    await userEvent.type(screen.getByLabelText('Email'), 'new@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect((await screen.findByRole('alert')).textContent).toContain('too short');
    expect(
      (client as unknown as { auth: { signUp: ReturnType<typeof vi.fn> } }).auth.signUp,
    ).not.toHaveBeenCalled();
  });
});

describe('<SsoCallbackPage>', () => {
  it('removes the ticket from the URL first, exchanges it on the server, sets the session, then bootstraps directly', async () => {
    window.history.pushState(null, '', '/sso/callback?sso_ticket=TICKET-123456');
    const order: string[] = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      order.push(`fetch:${url}|url=${window.location.search}`);
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', profile: {} }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = fakeClient({
      getSession: vi.fn(async () => {
        order.push('getSession');
        return { data: { session: null } };
      }),
    });
    const onDone = vi.fn();
    mount(
      <SsoCallbackPage
        search="?sso_ticket=TICKET-123456"
        pathname="/sso/callback"
        onDone={onDone}
        onBack={() => {}}
      />,
      client,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(order[0]).toBe('fetch:/api/sso-exchange|url='); // ticket already gone from the URL when the request is made
    expect(window.location.search).toBe('');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      ticket: 'TICKET-123456',
    });
    expect(
      (client as unknown as { auth: { setSession: ReturnType<typeof vi.fn> } }).auth.setSession,
    ).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r' });
    expect(order).toContain('getSession'); // explicit bootstrap, not just the listener
  });

  it('shows a real message and a way back when the ticket is rejected (never spins forever)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_ticket' }), { status: 401 })),
    );
    const onBack = vi.fn();
    mount(
      <SsoCallbackPage
        search="?sso_ticket=OLD-TICKET-1"
        pathname="/sso/callback"
        onDone={() => {}}
        onBack={onBack}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('expired or was already used');
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('a missing ticket is reported, not an endless spinner', async () => {
    mount(
      <SsoCallbackPage search="" pathname="/sso/callback" onDone={() => {}} onBack={() => {}} />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('expired');
  });
});
