import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { passWalletResponse, walletConfig, walletJwt } from './wallet.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  VITE_SITE_URL: 'https://bestie-pos.vercel.app',
  GOOGLE_WALLET_ISSUER_ID: '3388000000012345678',
  GOOGLE_WALLET_SA_EMAIL: 'wallet@proj.iam.gserviceaccount.com',
  GOOGLE_WALLET_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
};
const T = 'a'.repeat(32);
const pass = {
  name: 'Anna',
  code: 'BP-ABCDE23456',
  network: { slug: 'koh', name: { th: 'เกาะ', en: 'Koh Island' } },
  points: 120,
  activity: [],
  shops: [],
};
const fakeFetch = (data: unknown, status = 200) =>
  vi.fn(async () => Response.json(data, { status })) as unknown as typeof fetch;
const req = (t = T, ip = '1.1.1.1') =>
  new Request(`https://x/api/guest/pass-wallet?t=${t}`, { headers: { 'x-forwarded-for': ip } });

describe('Google Wallet pass', () => {
  it('reads the three server variables and refuses anything that does not look right', () => {
    expect(walletConfig(env)).toMatchObject({
      issuerId: '3388000000012345678',
      serviceAccount: 'wallet@proj.iam.gserviceaccount.com',
    });
    expect(walletConfig(env)!.privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
    expect(walletConfig({})).toBeNull();
    expect(walletConfig({ ...env, GOOGLE_WALLET_ISSUER_ID: 'abc' })).toBeNull();
    expect(walletConfig({ ...env, GOOGLE_WALLET_SA_EMAIL: 'me@gmail.com' })).toBeNull();
    expect(walletConfig({ ...env, GOOGLE_WALLET_PRIVATE_KEY: 'nope' })).toBeNull();
  });
  it('signs a JWT that verifies with the public key and carries the pass', () => {
    const cfg = walletConfig(env)!;
    const jwt = walletJwt(
      cfg,
      {
        code: 'BP-ABCDE23456',
        name: 'Anna',
        networkName: 'Koh Island',
        points: 120,
        link: `https://bestie-pos.vercel.app/pass/${T}`,
      },
      'https://bestie-pos.vercel.app',
      1_700_000_000,
    );
    const [h, b, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(
      createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')),
    ).toBe(true);
    const c = JSON.parse(Buffer.from(b, 'base64url').toString());
    expect(c).toMatchObject({
      iss: cfg.serviceAccount,
      aud: 'google',
      typ: 'savetowallet',
      iat: 1_700_000_000,
      origins: ['https://bestie-pos.vercel.app'],
    });
    const o = c.payload.genericObjects[0];
    expect(o.id).toBe('3388000000012345678.BP-ABCDE23456');
    expect(o.classId).toBe('3388000000012345678.bestie_tourist_pass');
    expect(o.barcode).toMatchObject({
      type: 'QR_CODE',
      value: `https://bestie-pos.vercel.app/pass/${T}`,
    });
    expect(o.textModulesData[0]).toMatchObject({ header: 'Points', body: '120' });
    expect(JSON.stringify(c)).not.toContain('PRIVATE KEY');
  });
  it('a tampered body no longer verifies', () => {
    const jwt = walletJwt(
      walletConfig(env)!,
      { code: 'BP-ABCDE23456', name: 'Anna', networkName: 'x', points: 1, link: 'https://x/y' },
      'https://x',
      1,
    );
    const [h, , s] = jwt.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ iss: 'evil' })).toString('base64url');
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${forged}`)
        .verify(publicKey, Buffer.from(s, 'base64url')),
    ).toBe(false);
  });
  it('returns the save link for a real pass', async () => {
    const res = await passWalletResponse(req(), env, {
      fetchImpl: fakeFetch(pass),
      now: () => 1_700_000_000_000,
    });
    const body = (await res.json()) as { available: boolean; url: string };
    expect(body.available).toBe(true);
    expect(body.url.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);
    expect(body.url.slice('https://pay.google.com/gp/v/save/'.length).split('.').length).toBe(3);
  });
  it('says not available when Google Wallet is not set up, never errors', async () => {
    const res = await passWalletResponse(
      req(T, '2.2.2.2'),
      { ...env, GOOGLE_WALLET_ISSUER_ID: '' },
      { fetchImpl: fakeFetch(pass) },
    );
    expect(await res.json()).toEqual({ available: false });
  });
  it('404 for an unknown pass, 422 for a bad token, 405 for other verbs', async () => {
    expect(
      (await passWalletResponse(req(T, '3.3.3.3'), env, { fetchImpl: fakeFetch(null) })).status,
    ).toBe(404);
    expect(
      (await passWalletResponse(req('zz', '4.4.4.4'), env, { fetchImpl: fakeFetch(pass) })).status,
    ).toBe(422);
    expect(
      (
        await passWalletResponse(
          new Request('https://x/api/guest/pass-wallet', { method: 'POST' }),
          env,
          { fetchImpl: fakeFetch(pass) },
        )
      ).status,
    ).toBe(405);
  });
});
