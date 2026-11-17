/**
 * Aivora (LINE) single sign-on — server side. Implements docs/SSO-Aivora-Supabase.md:
 *  - the browser never exchanges a ticket and never sees service_role;
 *  - accounts are found / linked by the hub's user id (`aivora_links`), NEVER by e-mail;
 *  - SSO proves WHO the person is, never WHAT they may do: no role is read from the hub payload;
 *  - every failure is logged here with a code (never tokens / keys) and mapped to an honest HTTP status.
 *
 * Everything that talks to the outside world is injected (`fetchImpl`, `SsoAdmin`) so the logic is unit-tested
 * without the hub or Supabase.
 */

export type HubUser = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  email: string | null;
};

export type SsoErrorCode =
  | 'bad_request'
  | 'invalid_ticket'
  | 'slug_mismatch'
  | 'hub_unreachable'
  | 'bad_payload'
  | 'not_configured'
  | 'server_error';

const STATUS: Record<SsoErrorCode, number> = {
  bad_request: 400,
  invalid_ticket: 401, // ticket expired / already used / wrong
  slug_mismatch: 403,
  hub_unreachable: 502, // only when the hub really cannot be reached
  bad_payload: 502,
  not_configured: 500,
  server_error: 500,
};

export class SsoError extends Error {
  readonly code: SsoErrorCode;
  readonly status: number;
  constructor(code: SsoErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SsoError';
    this.code = code;
    this.status = STATUS[code];
  }
}

export type SsoConfig = {
  /** e.g. https://aivora-lc.netlify.app/api/public/sso/exchange */
  hubExchangeUrl: string;
  /** The slug this app is registered under at the hub. */
  appSlug: string;
  /** Host used for synthetic e-mail addresses (aivora+<id>@host). */
  siteHost: string;
};

/** Hub returns `null` (not undefined) for missing fields; LINE users often have no e-mail. */
const nullableString = (v: unknown): v is string | null | undefined =>
  v == null || typeof v === 'string';

export function parseHubPayload(raw: unknown): { user: HubUser; appSlug: string } {
  const o = raw as { user?: Record<string, unknown>; app_slug?: unknown } | null;
  const u = o?.user;
  if (
    !u ||
    typeof u.id !== 'string' ||
    u.id.length === 0 ||
    !nullableString(u.display_name) ||
    !nullableString(u.avatar_url) ||
    !nullableString(u.email) ||
    typeof o?.app_slug !== 'string'
  ) {
    throw new SsoError('bad_payload', 'hub payload has an unexpected shape');
  }
  // `roles` and `firebase` are deliberately ignored: roles never come from SSO, firebase is always null for Supabase apps.
  return {
    user: {
      id: u.id,
      display_name: (u.display_name as string | null | undefined) ?? null,
      avatar_url: (u.avatar_url as string | null | undefined) ?? null,
      email: (u.email as string | null | undefined) ?? null,
    },
    appSlug: o.app_slug,
  };
}

/** Synthetic address: never matches a real mailbox, so a hub e-mail can never squat or take over an account. */
export const syntheticEmail = (hubUserId: string, siteHost: string): string =>
  `aivora+${hubUserId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}@${siteHost}`;

export type Session = { access_token: string; refresh_token: string };

export interface SsoAdmin {
  /** Supabase user already linked to this hub user, if any. */
  findLinkedUser(aivoraUserId: string): Promise<{ userId: string; email: string } | null>;
  /** Create a user + link row. Must be race-safe: on a duplicate link return the existing one. */
  createLinkedUser(input: {
    aivoraUserId: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    hubEmail: string | null;
  }): Promise<{ userId: string; email: string }>;
  issueSession(email: string): Promise<Session>;
  /** Fill only EMPTY profile columns (never overwrite what the user edited). */
  fillProfile(
    userId: string,
    fields: { displayName: string | null; avatarUrl: string | null },
  ): Promise<void>;
}

export type ExchangeResult = Session & {
  profile: { display_name: string | null; avatar_url: string | null };
};

export async function exchangeTicket(args: {
  ticket: unknown;
  config: SsoConfig;
  admin: SsoAdmin;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, string>) => void;
}): Promise<ExchangeResult> {
  const { ticket, config, admin, fetchImpl = fetch, log = () => {} } = args;
  if (!config.appSlug || !config.hubExchangeUrl)
    throw new SsoError('not_configured', 'AIVORA_APP_SLUG / hub URL missing');
  if (typeof ticket !== 'string' || ticket.length < 8 || ticket.length > 2048)
    throw new SsoError('bad_request', 'ticket missing');

  let res: Response;
  try {
    res = await fetchImpl(config.hubExchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
  } catch {
    throw new SsoError('hub_unreachable', 'could not reach the hub');
  }
  log('hub_exchange', { status: String(res.status) });
  if (
    res.status === 400 ||
    res.status === 401 ||
    res.status === 403 ||
    res.status === 404 ||
    res.status === 410
  ) {
    throw new SsoError('invalid_ticket', `hub rejected the ticket (${res.status})`);
  }
  if (!res.ok) throw new SsoError('hub_unreachable', `hub answered ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SsoError('bad_payload', 'hub answered with invalid JSON');
  }
  const { user, appSlug } = parseHubPayload(body);
  if (appSlug !== config.appSlug)
    throw new SsoError('slug_mismatch', 'ticket was issued for another app');

  // find by HUB USER ID — never by e-mail.
  let linked = await admin.findLinkedUser(user.id);
  if (!linked) {
    linked = await admin.createLinkedUser({
      aivoraUserId: user.id,
      email: syntheticEmail(user.id, config.siteHost),
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      hubEmail: user.email,
    });
    log('user_created');
  } else {
    await admin.fillProfile(linked.userId, {
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
    });
    log('user_found');
  }

  const session = await admin.issueSession(linked.email);
  log('session_issued');
  // Only what the browser needs: no service_role, no raw hub payload.
  return { ...session, profile: { display_name: user.display_name, avatar_url: user.avatar_url } };
}
