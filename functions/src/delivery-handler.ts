// Vercel Function for delivery platform orders (module `delivery`; the platform's intake token is the only key):
//   POST /api/delivery/intake   Authorization: Bearer <token>
//        { ref, name?, phone?, address?, note?, items: [{ item_id? | barcode? | sku?, quantity, note? }] }
//        → { ok: true, order_id, number, lines, replay } | { ok: false, error: 'unauthorized' | 'off' | 'invalid' | 'unknown_item' | 'too_many' }
// Every rule (token, module on, every item real and available, delivery price, the same platform order again = the first answer) is checked by the database function;
// this file only limits the request rate, checks the shape and talks to it with the service role. Nothing here takes or confirms money.
import { createRateLimiter } from './line.js';
import { readServerEnv } from './env.js';
import { clientKey, jsonObject, rpc } from './guest-extras-handler.js';

type Env = Record<string, string | undefined>;
export type DeliveryDeps = { fetchImpl?: typeof fetch };
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const TOKEN = /^[0-9a-f]{64}$/;
const allowIp = createRateLimiter(120, 60_000);
const allowToken = createRateLimiter(60, 60_000);

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export async function deliveryIntakeResponse(
  request: Request,
  env: Env = process.env,
  deps: DeliveryDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405);
  const f = deps.fetchImpl ?? fetch;
  try {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token || !TOKEN.test(token)) return reply({ ok: false, error: 'unauthorized' }, 401);
    if (!allowIp(`delivery:${clientKey(request)}`) || !allowToken(`delivery-token:${token}`))
      return reply({ ok: false, error: 'rate_limited' }, 429);
    const b = await jsonObject(request, 20_000);
    if (!b || !Array.isArray(b.items) || b.items.length < 1 || b.items.length > 40)
      return reply({ ok: false, error: 'invalid' }, 422);
    const items: Record<string, unknown>[] = [];
    for (const raw of b.items) {
      const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const quantity = typeof o.quantity === 'number' ? o.quantity : Number.NaN;
      if (!Number.isInteger(quantity)) return reply({ ok: false, error: 'invalid' }, 422);
      items.push({
        item_id: str(o.item_id, 40) || undefined,
        barcode: str(o.barcode, 40) || undefined,
        sku: str(o.sku, 40) || undefined,
        quantity,
        note: str(o.note, 200) || undefined,
      });
    }
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'delivery_intake', {
      p_token: token,
      p: {
        ref: str(b.ref, 60),
        name: str(b.name, 80) || undefined,
        phone: str(b.phone, 30) || undefined,
        address: str(b.address, 200) || undefined,
        note: str(b.note, 200) || undefined,
        items,
      },
    });
    if (!r.ok) return reply({ ok: false, error: 'server_error' }, 502);
    const o = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    if (o.ok === true)
      return reply({
        ok: true,
        order_id: o.order_id,
        number: o.number,
        lines: o.lines,
        replay: o.replay === true,
      });
    const error = typeof o.error === 'string' ? o.error : 'invalid';
    const status = error === 'unauthorized' ? 401 : error === 'too_many' ? 429 : 422;
    return reply(
      { ok: false, error, item: typeof o.item === 'string' ? o.item : undefined },
      status,
    );
  } catch {
    return reply({ ok: false, error: 'server_error' }, 502);
  }
}
