import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider, dict } from '@bestie/i18n';
import { LineDiagnosis, diagText } from './LineDiagnosis';
import type { DiagCheck } from './LineDiagnosis';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ctx = {
  client: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } },
} as unknown as PageContext;
const mount = () =>
  render(
    <I18nProvider initialLang="en">
      <LineDiagnosis ctx={ctx} />
    </I18nProvider>,
  );
const answer = (checks: DiagCheck[], status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            checks,
            expectedWebhook: 'https://bestie-pos.vercel.app/api/line/webhook',
          }),
          { status },
        ),
    ),
  );

describe('diagText', () => {
  const en = dict.en;
  it('turns a check into a sentence with its facts', () => {
    expect(diagText(en, { id: 'env', level: 'fail', data: { names: 'LINE_BASIC_ID' } })).toContain(
      'LINE_BASIC_ID',
    );
    expect(
      diagText(en, {
        id: 'webhook_url',
        level: 'fail',
        data: { reason: 'inactive', url: 'https://x/y' },
      }),
    ).toContain('"Use webhook" is OFF');
    expect(
      diagText(en, { id: 'recent', level: 'fail', data: { reason: 'signature', n: 2 } }),
    ).toContain('signature');
    expect(
      diagText(en, {
        id: 'webhook_test',
        level: 'fail',
        data: { status: 401, reason: 'Unauthorized' },
      }),
    ).toContain('401');
  });
  it('an unknown check still shows something readable, never a raw key', () => {
    expect(diagText(en, { id: 'future', level: 'warn' })).toBe('Unknown result');
  });
  it('has a Thai sentence for every check the server can send', () => {
    for (const k of [
      'env_ok',
      'token_fail',
      'basic_id_warn',
      'webhook_url_fail_none',
      'webhook_test_fail',
      'recent_warn_none',
      'recent_fail_reply',
      'pending_info',
    ])
      expect((dict.th as Record<string, string>)[`lineDiag_${k}`]).toBeTruthy();
  });
});

describe('<LineDiagnosis>', () => {
  it('runs the check and lists every result with what to do, plus the address to set', async () => {
    answer([
      { id: 'env', level: 'ok' },
      {
        id: 'webhook_url',
        level: 'fail',
        data: { reason: 'none', expected: 'https://bestie-pos.vercel.app/api/line/webhook' },
      },
      { id: 'recent', level: 'warn', data: { reason: 'none' } },
    ]);
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(/No webhook URL is set/)).toBeTruthy();
    expect(screen.getByText(/All 4 LINE variables are set/)).toBeTruthy();
    expect(screen.getAllByText('Fix')).toHaveLength(1);
    expect(screen.getByText(/Webhook URL to set in LINE Developers/)).toBeTruthy();
    expect(screen.getAllByText(/Response settings/).length).toBeGreaterThan(0);
  });

  it('says so when the check itself fails (not the platform admin, no network)', async () => {
    answer([], 403);
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('The check failed. Try again.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('list')).toBeNull());
  });
});
