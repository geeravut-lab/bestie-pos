import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { HealthForm } from './HealthForm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
let posts: Record<string, unknown>[];
const route = (enabled: boolean, result: unknown = { ok: true }) =>
  vi.fn(async (_u: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(result));
    }
    return new Response(JSON.stringify({ enabled }));
  });
const mount = () =>
  render(
    <I18nProvider initialLang="en">
      <HealthForm token={'a'.repeat(32)} id="b1" code="ABCD1234" />
    </I18nProvider>,
  );

describe('<HealthForm> on the guest phone', () => {
  it('shows nothing where the shop does not offer it (not a spa)', async () => {
    posts = [];
    vi.stubGlobal('fetch', route(false));
    const { container } = mount();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('will not send without the consent tick and a typed name', async () => {
    posts = [];
    vi.stubGlobal('fetch', route(true));
    mount();
    await screen.findByText('Health form before your visit');
    await userEvent.click(screen.getByRole('button', { name: 'Send the form with my signature' }));
    expect(await screen.findByText(/must agree/)).toBeTruthy();
    expect(posts.length).toBe(0);
  });

  it('sends the answers, consent and signature with the booking code', async () => {
    posts = [];
    vi.stubGlobal('fetch', route(true));
    mount();
    await screen.findByText('Health form before your visit');
    await userEvent.click(screen.getByLabelText('High blood pressure'));
    await userEvent.type(
      screen.getByLabelText('Allergies (medicine, food, chemicals, oils)'),
      'nuts',
    );
    await userEvent.click(screen.getByLabelText(/I confirm this is correct/));
    await userEvent.type(screen.getByLabelText('Signature (type the full name)'), 'Anna Lee');
    await userEvent.click(screen.getByRole('button', { name: 'Send the form with my signature' }));
    expect(await screen.findByText('Sent. Thank you.')).toBeTruthy();
    expect(posts[0]).toMatchObject({
      op: 'health',
      id: 'b1',
      code: 'ABCD1234',
      form: {
        consent: true,
        signed_name: 'Anna Lee',
        answers: { high_bp: true, allergies: 'nuts' },
      },
    });
  });
});
