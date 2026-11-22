const crypto = require('crypto');
const { open } = require('./lib.cjs');
const SECRET = 'bestie-local-jwt-secret-at-least-32-characters-long';
const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (p) => {
  const h = b({ alg: 'HS256', typ: 'JWT' }),
    pl = b(p);
  return `${h}.${pl}.${crypto
    .createHmac('sha256', SECRET)
    .update(h + '.' + pl)
    .digest('base64url')}`;
};
exports.staffPage = async ({ uid, email, device, viewport }) => {
  const o = await open(viewport ? { viewport } : {});
  const exp = 4102444800;
  const token = sign({
    role: 'authenticated',
    aud: 'authenticated',
    sub: uid,
    email,
    iss: 'supabase',
    exp,
  });
  const session = {
    access_token: token,
    refresh_token: 'x',
    token_type: 'bearer',
    expires_in: 9999999,
    expires_at: exp,
    user: {
      id: uid,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  };
  await o.page.addInitScript(
    ([s, d]) => {
      try {
        localStorage.setItem('sb-127-auth-token', JSON.stringify(s));
        if (d) localStorage.setItem('bestie-device', JSON.stringify(d));
      } catch {}
    },
    [session, device],
  );
  return o;
};
exports.DEV = {
  cafe: {
    deviceId: 'f1f97682-5eea-4f83-897d-960a6d32a86e',
    orgId: '9dbd7a0f-4cc2-4bb1-8a15-8b6703f369c0',
    storeId: '940ae8f9-862f-4ae7-8df4-5558c294fd18',
    name: 'Café counter',
    code: 'A',
    role: 'cashier',
    reader: false,
    station: null,
    posId: null,
  },
  kitchen: {
    deviceId: '94c3df75-b5da-4265-9160-0c2acc5f3918',
    orgId: '9dbd7a0f-4cc2-4bb1-8a15-8b6703f369c0',
    storeId: 'f9bf298b-9ffa-4aa2-9d01-c003e9114604',
    name: 'Counter 1',
    code: 'A',
    role: 'cashier',
    reader: false,
    station: null,
    posId: null,
  },
};
