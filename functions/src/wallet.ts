// Google Wallet "Add to Google Wallet" link for a Tourist Pass (module: island network). A pass is a Google Wallet GENERIC object signed as an RS256 JWT with the
// platform's service account; the link `https://pay.google.com/gp/v/save/<jwt>` is all the guest's phone needs. Nothing is stored at Google until the guest taps it.
// Needs three server variables from a Google Wallet issuer account (docs/ENVIRONMENT.md): GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL, GOOGLE_WALLET_PRIVATE_KEY.
// Apple Wallet is NOT built: a .pkpass must be signed with an Apple Developer certificate that only the owner can obtain.
import { createSign } from 'node:crypto';
import { readServerEnv } from './env.js';
import { clientKey, rpc } from './guest-extras-handler.js';
import { createRateLimiter } from './line.js';
import { parsePass } from '../../packages/core/src/network.js';

type Env = Record<string, string | undefined>;
export type WalletConfig = { issuerId: string; serviceAccount: string; privateKey: string };

export function walletConfig(env: Env): WalletConfig | null {
  const issuerId = env.GOOGLE_WALLET_ISSUER_ID?.trim() ?? '';
  const serviceAccount = env.GOOGLE_WALLET_SA_EMAIL?.trim() ?? '';
  const privateKey = (env.GOOGLE_WALLET_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (
    !/^\d{6,25}$/.test(issuerId) ||
    !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(serviceAccount) ||
    !privateKey.includes('PRIVATE KEY')
  )
    return null;
  return { issuerId, serviceAccount, privateKey };
}

const b64url = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

/** The signed JWT for one pass. Pure apart from the clock and the signature; tested with a generated key. */
export function walletJwt(
  cfg: WalletConfig,
  pass: { code: string; name: string; networkName: string; points: number; link: string },
  origin: string,
  nowSeconds: number,
): string {
  const classId = `${cfg.issuerId}.bestie_tourist_pass`;
  const objectId = `${cfg.issuerId}.${pass.code.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const claims = {
    iss: cfg.serviceAccount,
    aud: 'google',
    typ: 'savetowallet',
    iat: nowSeconds,
    origins: [origin],
    payload: {
      genericClasses: [{ id: classId }],
      genericObjects: [
        {
          id: objectId,
          classId,
          state: 'ACTIVE',
          cardTitle: { defaultValue: { language: 'en', value: pass.networkName } },
          header: { defaultValue: { language: 'en', value: pass.name } },
          subheader: { defaultValue: { language: 'en', value: pass.code } },
          barcode: { type: 'QR_CODE', value: pass.link, alternateText: pass.code },
          textModulesData: [{ id: 'points', header: 'Points', body: String(pass.points) }],
          linksModuleData: { uris: [{ id: 'pass', uri: pass.link, description: 'Open my pass' }] },
          hexBackgroundColor: '#0f766e',
        },
      ],
    },
  };
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const TOKEN = /^[0-9a-f]{32}$/;
const allow = createRateLimiter(10, 60_000);

/** GET /api/guest/pass-wallet?t=<pass token> → { available: false } | { available: true, url }. The pass token is the only key. */
export async function passWalletResponse(
  request: Request,
  env: Env = process.env,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<Response> {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  if (!allow(`wallet:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
  const t = new URL(request.url).searchParams.get('t') ?? '';
  if (!TOKEN.test(t)) return reply({ error: 'invalid' }, 422);
  const cfg = walletConfig(env);
  if (!cfg) return reply({ available: false });
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const r = await rpc(deps.fetchImpl ?? fetch, supabaseUrl, serviceRoleKey, 'guest_pass', {
      p_token: t,
    });
    if (!r.ok) return reply({ error: 'server_error' }, 502);
    const pass = parsePass(r.data);
    if (!pass) return reply({ error: 'not_found' }, 404);
    const origin = (env.VITE_SITE_URL?.trim() || new URL(request.url).origin).replace(/\/+$/, '');
    const jwt = walletJwt(
      cfg,
      {
        code: pass.code,
        name: pass.name,
        networkName: pass.network.name.en || pass.network.name.th,
        points: pass.points,
        link: `${origin}/pass/${t}`,
      },
      origin,
      Math.floor((deps.now ?? Date.now)() / 1000),
    );
    return reply({ available: true, url: `https://pay.google.com/gp/v/save/${jwt}` });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}
