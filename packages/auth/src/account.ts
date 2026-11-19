/**
 * What to call the signed-in person on the account page.
 * A LINE (Aivora) account has a made-up e-mail address (`aivora+<id>@<site host>`, see docs/DECISIONS.md) that means nothing to the
 * person, so for those the NAME Aivora sent is shown; an e-mail or Google account shows its e-mail as before.
 */
export type AccountUser = {
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

const SYNTHETIC = /^aivora\+[^@]+@/i;

export const isAivoraUser = (u: AccountUser | null | undefined): boolean =>
  !!u && (u.app_metadata?.provider === 'aivora' || SYNTHETIC.test(u.email ?? ''));

const clean = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;

export type AccountLabel =
  | { kind: 'text'; text: string }
  /** A LINE account whose name we do not know yet: the screen says "LINE (Aivora) account". */
  | { kind: 'line-anonymous' }
  | { kind: 'none' };

/** `profileName` = the name in the person's own profile row (a fallback for accounts made before the hub name was stored). */
export function accountLabel(
  u: AccountUser | null | undefined,
  profileName?: string | null,
): AccountLabel {
  if (!u) return { kind: 'none' };
  if (isAivoraUser(u)) {
    const name =
      clean(u.user_metadata?.display_name) ?? clean(u.user_metadata?.name) ?? clean(profileName);
    return name ? { kind: 'text', text: name } : { kind: 'line-anonymous' };
  }
  const email = clean(u.email);
  if (email) return { kind: 'text', text: email };
  const name = clean(u.user_metadata?.display_name) ?? clean(profileName);
  return name ? { kind: 'text', text: name } : { kind: 'none' };
}
