// PMS adapters (owner order 7.1): a hotel system (Cloudbeds, Mews) is the source of "who is in the house" and the place a room charge is posted.
// Provider-neutral interface; the adapters are written from the providers' PUBLIC documentation and unit-tested with a fake HTTP client.
// NOT run against a real Cloudbeds / Mews account (the owner has none yet): a sandbox run is needed before any resort relies on it,
// and the endpoint paths / field names below must be checked against the provider's current documentation at that time.
// Nothing here is wired to the till yet: the resort's own folio (migration 74) keeps working without any PMS.
export type PmsGuest = {
  reservationId: string;
  guestName: string;
  room: string;
  checkIn: string;
  checkOut: string;
};
export type PmsCharge = {
  reservationId: string;
  amountSatang: number;
  description: string;
  reference: string;
};
export interface PmsAdapter {
  readonly name: 'cloudbeds' | 'mews';
  /** guests currently checked in */
  inHouse(): Promise<PmsGuest[]>;
  /** post a charge on a guest's account; `reference` makes a repeat harmless where the provider supports it */
  postCharge(c: PmsCharge): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
}
type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
const baht = (satang: number) => Math.round(satang) / 100;

export function cloudbedsAdapter(env: Env, f: Fetch = fetch): PmsAdapter | null {
  const key = env.CLOUDBEDS_API_KEY;
  const base = env.CLOUDBEDS_BASE_URL ?? 'https://api.cloudbeds.com/api/v1.2';
  if (!key || !base.startsWith('https://')) return null;
  const headers = { Authorization: `Bearer ${key}` };
  return {
    name: 'cloudbeds',
    async inHouse() {
      const r = await f(`${base}/getReservations?status=checked_in&pageSize=100`, { headers });
      if (!r.ok) throw new Error(`cloudbeds ${r.status}`);
      const j = (await r.json()) as { data?: Record<string, unknown>[] };
      return (j.data ?? []).map((x) => ({
        reservationId: String(x.reservationID ?? ''),
        guestName: String(x.guestName ?? ''),
        room: String(x.roomName ?? x.roomID ?? ''),
        checkIn: String(x.startDate ?? ''),
        checkOut: String(x.endDate ?? ''),
      }));
    },
    async postCharge(c) {
      const body = new URLSearchParams({
        reservationID: c.reservationId,
        itemName: c.description.slice(0, 100),
        itemPrice: String(baht(c.amountSatang)),
        itemQuantity: '1',
        itemNote: c.reference,
      });
      const r = await f(`${base}/postCustomItem`, { method: 'POST', headers, body });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { itemID?: string };
        message?: string;
      };
      return r.ok && j.success !== false
        ? { ok: true, id: String(j.data?.itemID ?? c.reference) }
        : { ok: false, error: j.message ?? `cloudbeds ${r.status}` };
    },
  };
}

export function mewsAdapter(env: Env, f: Fetch = fetch): PmsAdapter | null {
  const client = env.MEWS_CLIENT_TOKEN;
  const access = env.MEWS_ACCESS_TOKEN;
  const base = env.MEWS_BASE_URL ?? 'https://api.mews.com/api/connector/v1';
  if (!client || !access || !base.startsWith('https://')) return null;
  const auth = { ClientToken: client, AccessToken: access, Client: 'Bestie POS' };
  const post = async (path: string, body: Record<string, unknown>) => {
    const r = await f(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...auth, ...body }),
    });
    return {
      status: r.status,
      json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };
  return {
    name: 'mews',
    async inHouse() {
      const r = await post('reservations/getAll/2023-06-06', {
        States: ['Started'],
        Limitation: { Count: 100 },
        Extent: { Reservations: true, Customers: true, Resources: true },
      });
      if (r.status !== 200) throw new Error(`mews ${r.status}`);
      const customers = new Map(
        ((r.json.Customers as Record<string, unknown>[]) ?? []).map((c) => [
          String(c.Id),
          `${c.FirstName ?? ''} ${c.LastName ?? ''}`.trim(),
        ]),
      );
      const resources = new Map(
        ((r.json.Resources as Record<string, unknown>[]) ?? []).map((x) => [
          String(x.Id),
          String(x.Name ?? ''),
        ]),
      );
      return ((r.json.Reservations as Record<string, unknown>[]) ?? []).map((x) => ({
        reservationId: String(x.Id ?? ''),
        guestName: customers.get(String(x.AccountId ?? x.CustomerId ?? '')) ?? '',
        room: resources.get(String(x.AssignedResourceId ?? '')) ?? '',
        checkIn: String(x.StartUtc ?? ''),
        checkOut: String(x.EndUtc ?? ''),
      }));
    },
    async postCharge(c) {
      const r = await post('orders/add', {
        AccountId: c.reservationId,
        Notes: c.reference,
        Items: [
          {
            Name: c.description.slice(0, 100),
            UnitCount: 1,
            UnitAmount: { Currency: 'THB', GrossValue: baht(c.amountSatang) },
          },
        ],
      });
      return r.status === 200
        ? { ok: true, id: String(r.json.OrderId ?? c.reference) }
        : { ok: false, error: String(r.json.Message ?? `mews ${r.status}`) };
    },
  };
}

/** The configured PMS (`PMS_PROVIDER` = cloudbeds | mews); an unknown or unconfigured provider is "none", never a fallback. */
export function pmsFromEnv(env: Env = process.env, f: Fetch = fetch): PmsAdapter | null {
  if (env.PMS_PROVIDER === 'cloudbeds') return cloudbedsAdapter(env, f);
  if (env.PMS_PROVIDER === 'mews') return mewsAdapter(env, f);
  return null;
}
