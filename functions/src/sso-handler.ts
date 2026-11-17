import { readServerEnv } from './env.js';
import { createSupabaseSsoAdmin } from './sso-admin.js';
import { SsoError, exchangeTicket } from './sso.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** POST /api/sso-exchange  { ticket } → { access_token, refresh_token, profile }. Mounted by apps/pos/api. */
export async function ssoExchangeResponse(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  if (request.method !== 'POST')
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { ...JSON_HEADERS, Allow: 'POST' } },
    );
  try {
    const body = (await request.json().catch(() => null)) as { ticket?: unknown } | null;
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const result = await exchangeTicket({
      ticket: body?.ticket,
      config: {
        hubExchangeUrl:
          env.AIVORA_HUB_EXCHANGE_URL ?? 'https://aivora-lc.netlify.app/api/public/sso/exchange',
        appSlug: env.AIVORA_APP_SLUG ?? '',
        siteHost: env.SITE_HOST ?? 'bestie-pos.vercel.app',
      },
      admin: createSupabaseSsoAdmin(supabaseUrl, serviceRoleKey),
      log: (event, detail) => console.info('[sso]', event, detail ?? ''),
    });
    return Response.json(result, { headers: JSON_HEADERS });
  } catch (e) {
    // Log EVERY failure — including the ones we throw ourselves — with a code, never a token or key.
    if (e instanceof SsoError) {
      console.error('[sso] rejected', e.code, e.message);
      return Response.json({ error: e.code }, { status: e.status, headers: JSON_HEADERS });
    }
    console.error('[sso] failed', e instanceof Error ? e.message : 'unknown');
    return Response.json({ error: 'server_error' }, { status: 500, headers: JSON_HEADERS });
  }
}
