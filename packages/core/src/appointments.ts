import type { LocalizedText } from './types';
import type { Satang } from './money';

/**
 * Appointments and resources (Phase 2), the pure part: reading rows, the status flow, overlap checks (the database decides in the end —
 * this lets the screen warn before asking) and the day-calendar layout. All times are shown in Bangkok time (UTC+7, no daylight saving).
 */
export const APPOINTMENT_STATUSES = [
  'booked',
  'confirmed',
  'arrived',
  'in_service',
  'done',
  'cancelled',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
/** These keep the provider and the room busy; done / cancelled / no-show free them. */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  'booked',
  'confirmed',
  'arrived',
  'in_service',
];

export const PROVIDER_KINDS = ['stylist', 'therapist'] as const;
export const PLACE_KINDS = ['room', 'bed', 'chair'] as const;
export const RESOURCE_KINDS = [...PROVIDER_KINDS, ...PLACE_KINDS] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const isProviderKind = (k: ResourceKind): boolean =>
  (PROVIDER_KINDS as readonly string[]).includes(k);

export type Resource = {
  id: string;
  name: string;
  kind: ResourceKind;
  active: boolean;
  sort: number;
  /** The staff member behind a stylist / therapist (commission and tips go to them). */
  staffId: string | null;
};
export type Appointment = {
  id: string;
  providerId: string | null;
  placeId: string | null;
  serviceName: LocalizedText;
  price: Satang;
  guestName: string;
  guestPhone: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: 'staff' | 'online';
  note: string | null;
  /** The bill made from this appointment, once there is one. */
  orderId: string | null;
  /** The member (when known) and the package visit that covers this appointment. */
  customerId: string | null;
  customerPackageId: string | null;
};

/** What may follow each status (the database enforces the same table). */
export function nextStatuses(s: AppointmentStatus): AppointmentStatus[] {
  switch (s) {
    case 'booked':
      return ['confirmed', 'arrived', 'cancelled', 'no_show'];
    case 'confirmed':
      return ['arrived', 'cancelled', 'no_show'];
    case 'arrived':
      return ['in_service', 'cancelled'];
    case 'in_service':
      return ['done'];
    default:
      return [];
  }
}
export const canMove = (s: AppointmentStatus): boolean => s === 'booked' || s === 'confirmed';

const ms = (iso: string): number => Date.parse(iso);

/** Two time ranges overlap when each starts before the other ends — touching ends do not overlap (back to back is fine). */
export const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean =>
  ms(aStart) < ms(bEnd) && ms(aEnd) > ms(bStart);

/** The appointment that already holds the same provider or the same room at that time, or null. */
export function findConflict(
  existing: readonly Appointment[],
  cand: {
    providerId: string | null;
    placeId: string | null;
    startsAt: string;
    endsAt: string;
    ignoreId?: string;
  },
): Appointment | null {
  for (const a of existing) {
    if (a.id === cand.ignoreId || !BLOCKING_STATUSES.includes(a.status)) continue;
    const sameProvider = !!cand.providerId && a.providerId === cand.providerId;
    const samePlace = !!cand.placeId && a.placeId === cand.placeId;
    if ((sameProvider || samePlace) && overlaps(a.startsAt, a.endsAt, cand.startsAt, cand.endsAt))
      return a;
  }
  return null;
}

// ── Bangkok time ──
const BKK_MS = 7 * 3_600_000;
const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-19" + "14:30" → "2026-11-19T14:30:00+07:00" (null when either part is not a real date / time). */
export function toBangkokIso(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const h = Number(t[1]);
  const m = Number(t[2]);
  if (h > 23 || m > 59) return null;
  const probe = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
  if (probe.getUTCMonth() !== Number(d[2]) - 1 || probe.getUTCDate() !== Number(d[3])) return null;
  return `${date}T${t[1]}:${t[2]}:00+07:00`;
}

/** An instant as Bangkok date + minutes since midnight. */
export function bangkokParts(iso: string): { date: string; minutes: number } {
  const d = new Date(ms(iso) + BKK_MS);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
export const timeLabel = (minutes: number): string =>
  `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** The instants a Bangkok day starts and ends (end = start of the next day). */
export function bangkokDayBounds(date: string): { from: string; to: string } | null {
  const from = toBangkokIso(date, '00:00');
  if (!from) return null;
  const next = new Date(ms(from) + 24 * 3_600_000 + BKK_MS);
  const to = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T00:00:00+07:00`;
  return { from, to };
}
export function addDays(date: string, n: number): string {
  const b = toBangkokIso(date, '12:00');
  return b ? bangkokParts(new Date(ms(b) + n * 24 * 3_600_000).toISOString()).date : date;
}

// ── the day calendar ──
export type Placed = { id: string; topPct: number; heightPct: number; lane: number; lanes: number };

/**
 * Where each appointment of ONE column sits between `startMin` and `endMin` (minutes since midnight): top and height in percent of the
 * visible window, clipped to it. Appointments that overlap in time share the column side by side (lanes) — that happens in the
 * "no provider" column, never for a real provider (the database keeps those free).
 */
export function layoutColumn(
  items: readonly Pick<Appointment, 'id' | 'startsAt' | 'endsAt'>[],
  date: string,
  startMin: number,
  endMin: number,
): Placed[] {
  const span = endMin - startMin;
  const rows = items
    .map((a) => {
      const s = bangkokParts(a.startsAt);
      const e = bangkokParts(a.endsAt);
      const sMin = s.date === date ? s.minutes : s.date < date ? 0 : 24 * 60;
      const eMin = e.date === date ? e.minutes : e.date > date ? 24 * 60 : 0;
      return { id: a.id, s: Math.max(sMin, startMin), e: Math.min(eMin, endMin) };
    })
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const laneEnds: number[] = [];
  const placed = rows.map((r) => {
    let lane = laneEnds.findIndex((end) => end <= r.s);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = r.e;
    return { r, lane };
  });
  return placed.map(({ r, lane }) => {
    // lanes in use while this one runs
    const lanes = Math.max(
      1,
      ...placed.filter((o) => o.r.s < r.e && o.r.e > r.s).map((o) => o.lane + 1),
    );
    return {
      id: r.id,
      topPct: ((r.s - startMin) / span) * 100,
      heightPct: ((r.e - r.s) / span) * 100,
      lane,
      lanes,
    };
  });
}

// ── reading rows ──
const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseResources(raw: unknown): Resource[] {
  if (!Array.isArray(raw)) return [];
  const out: Resource[] = [];
  for (const r of raw) {
    if (!isRec(r) || typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    if (!(RESOURCE_KINDS as readonly unknown[]).includes(r.kind)) continue;
    out.push({
      id: r.id,
      name: r.name,
      kind: r.kind as ResourceKind,
      active: r.active !== false,
      sort: int(r.sort),
      staffId: str(r.staff_id),
    });
  }
  return out.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export function parseAppointments(raw: unknown): Appointment[] {
  if (!Array.isArray(raw)) return [];
  const out: Appointment[] = [];
  for (const r of raw) {
    if (
      !isRec(r) ||
      typeof r.id !== 'string' ||
      typeof r.starts_at !== 'string' ||
      typeof r.ends_at !== 'string' ||
      !isRec(r.service_name) ||
      typeof r.service_name.th !== 'string' ||
      !(APPOINTMENT_STATUSES as readonly unknown[]).includes(r.status)
    )
      continue;
    out.push({
      id: r.id,
      providerId: str(r.provider_id),
      placeId: str(r.place_id),
      serviceName: {
        th: r.service_name.th,
        ...(typeof r.service_name.en === 'string' && r.service_name.en
          ? { en: r.service_name.en }
          : {}),
      },
      price: int(r.price),
      guestName: typeof r.guest_name === 'string' ? r.guest_name : '',
      guestPhone: str(r.guest_phone),
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status as AppointmentStatus,
      source: r.source === 'online' ? 'online' : 'staff',
      note: str(r.note),
      orderId: str(r.order_id),
      customerId: str(r.customer_id),
      customerPackageId: str(r.customer_package_id),
    });
  }
  return out.sort((a, b) => ms(a.startsAt) - ms(b.startsAt));
}

// ── billing and deposits ──
/** A visit can be billed once the guest has arrived (or when it already has a bill to go to). */
export const canBill = (a: Pick<Appointment, 'status' | 'orderId'>): boolean =>
  a.orderId !== null || a.status === 'arrived' || a.status === 'in_service' || a.status === 'done';

export const DEPOSIT_METHODS = ['cash', 'promptpay', 'gateway'] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export type DepositStatus = 'held' | 'on_bill' | 'forfeited' | 'refunded';
export type Deposit = {
  id: string;
  appointmentId: string;
  amount: Satang;
  method: DepositMethod;
  status: DepositStatus;
  reference: string | null;
};

/** The usual deposit: a share of the price (default 30 %), rounded to a whole baht, never above the price. */
export function suggestDeposit(price: Satang, bps = 3000): Satang {
  if (price <= 0) return 0;
  const raw = Math.round((price * bps) / 10_000 / 100) * 100;
  return Math.min(price, Math.max(100, raw));
}

/** What the deposits of one appointment add up to. `open` is held or already on the bill (money the shop is holding for this visit). */
export function depositTotals(ds: readonly Pick<Deposit, 'amount' | 'status'>[]): {
  held: Satang;
  onBill: Satang;
  open: Satang;
  forfeited: Satang;
  refunded: Satang;
} {
  const sum = (s: DepositStatus) =>
    ds.filter((d) => d.status === s).reduce((a, d) => a + d.amount, 0);
  const held = sum('held');
  const onBill = sum('on_bill');
  return {
    held,
    onBill,
    open: held + onBill,
    forfeited: sum('forfeited'),
    refunded: sum('refunded'),
  };
}

/** How much more can be taken as a deposit (the database refuses more than the price in total). */
export const depositRoom = (
  price: Satang,
  ds: readonly Pick<Deposit, 'amount' | 'status'>[],
): Satang => Math.max(0, price - depositTotals(ds).open);

/** A deposit can be taken before the service; it is settled (kept or refunded) when the visit was cancelled or missed. */
export const canTakeDeposit = (s: AppointmentStatus): boolean =>
  s === 'booked' || s === 'confirmed' || s === 'arrived';
export const canSettleDeposit = (s: AppointmentStatus): boolean =>
  s === 'cancelled' || s === 'no_show';

const DEP_STATUSES: readonly DepositStatus[] = ['held', 'on_bill', 'forfeited', 'refunded'];
export function parseDeposits(raw: unknown): Deposit[] {
  if (!Array.isArray(raw)) return [];
  const out: Deposit[] = [];
  for (const r of raw) {
    if (
      !isRec(r) ||
      typeof r.id !== 'string' ||
      typeof r.appointment_id !== 'string' ||
      !(DEPOSIT_METHODS as readonly unknown[]).includes(r.method) ||
      !(DEP_STATUSES as readonly unknown[]).includes(r.status)
    )
      continue;
    const amount = int(r.amount);
    if (amount <= 0) continue;
    out.push({
      id: r.id,
      appointmentId: r.appointment_id,
      amount,
      method: r.method as DepositMethod,
      status: r.status as DepositStatus,
      reference: str(r.reference),
    });
  }
  return out;
}
