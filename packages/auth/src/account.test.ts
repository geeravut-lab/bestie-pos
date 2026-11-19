import { describe, expect, it } from 'vitest';
import { accountLabel, isAivoraUser } from './account';

const line = (over = {}) => ({
  email: 'aivora+zir5hkgeg3zgiahdsob2il7qqd62@bestie-pos.vercel.app',
  app_metadata: { provider: 'aivora', providers: ['email'] },
  user_metadata: { display_name: 'Somchai', hub_email: 'real@example.com' },
  ...over,
});

describe('accountLabel', () => {
  it('a LINE (Aivora) account shows the name Aivora sent, never the made-up e-mail or the hub e-mail', () => {
    const l = accountLabel(line());
    expect(l).toEqual({ kind: 'text', text: 'Somchai' });
  });
  it('is recognised by the provider or by the made-up address alone', () => {
    expect(isAivoraUser(line())).toBe(true);
    expect(isAivoraUser(line({ app_metadata: {} }))).toBe(true);
    expect(isAivoraUser({ email: 'owner@example.com', app_metadata: { provider: 'email' } })).toBe(
      false,
    );
    expect(isAivoraUser(null)).toBe(false);
  });
  it('falls back to the profile name, then to a plain "LINE account" label — still not the e-mail', () => {
    const noName = line({ user_metadata: {} });
    expect(accountLabel(noName, '  Mali ')).toEqual({ kind: 'text', text: 'Mali' });
    expect(accountLabel(noName, null)).toEqual({ kind: 'line-anonymous' });
    expect(accountLabel(noName, '   ')).toEqual({ kind: 'line-anonymous' });
  });
  it('an e-mail or Google account still shows its e-mail', () => {
    expect(
      accountLabel({
        email: 'owner@example.com',
        app_metadata: { provider: 'google' },
        user_metadata: { display_name: 'Owner' },
      }),
    ).toEqual({ kind: 'text', text: 'owner@example.com' });
  });
  it('without an e-mail it uses a name, and with nothing at all says nothing', () => {
    expect(accountLabel({ email: null, user_metadata: { display_name: 'Nok' } })).toEqual({
      kind: 'text',
      text: 'Nok',
    });
    expect(accountLabel({ email: '' })).toEqual({ kind: 'none' });
    expect(accountLabel(undefined)).toEqual({ kind: 'none' });
  });
  it('a very long name is cut so it cannot stretch the page', () => {
    const l = accountLabel(line({ user_metadata: { display_name: 'ก'.repeat(300) } }));
    expect(l.kind === 'text' && l.text.length).toBe(80);
  });
});
