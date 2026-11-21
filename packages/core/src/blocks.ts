// Days off / breaks and group bookings: turning what a person types (Bangkok dates and clock times) into what the database takes.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;

const instant = (date: string, time: string): number => Date.parse(`${date}T${time}:00+07:00`);
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The time range of a day off or a break, in Bangkok time.
 * All day: from the start of the first day to the end of the last day. With hours: from the first day's start time to the last day's end time.
 * Returns null for anything that is not a valid range (bad dates, end not after start, more than 62 days).
 */
export function blockRange(input: {
  fromDate: string;
  toDate: string;
  allDay: boolean;
  timeFrom?: string;
  timeTo?: string;
}): { startsAt: string; endsAt: string } | null {
  if (!DATE.test(input.fromDate) || !DATE.test(input.toDate)) return null;
  let start: number;
  let end: number;
  if (input.allDay) {
    start = instant(input.fromDate, '00:00');
    end = instant(input.toDate, '00:00') + DAY_MS;
  } else {
    if (!TIME.test(input.timeFrom ?? '') || !TIME.test(input.timeTo ?? '')) return null;
    start = instant(input.fromDate, input.timeFrom!);
    end = instant(input.toDate, input.timeTo!);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start > 62 * DAY_MS) return null;
  return { startsAt: iso(start), endsAt: iso(end) };
}

export type GroupPartInput = { serviceId: string; providerId: string; guestName: string };

/** The body of `book_group`: two to eight parts at one start time; a part with no name of its own uses the group's. */
export function groupPayload(input: {
  storeId: string;
  date: string;
  time: string;
  guestName: string;
  guestPhone: string;
  parts: readonly GroupPartInput[];
}): Record<string, unknown> | null {
  if (!DATE.test(input.date) || !TIME.test(input.time)) return null;
  if (input.guestName.trim() === '') return null;
  const parts = input.parts.filter((p) => p.serviceId !== '' && p.providerId !== '');
  if (parts.length < 2 || parts.length > 8) return null;
  return {
    store_id: input.storeId,
    starts_at: `${input.date}T${input.time}:00+07:00`,
    guest_name: input.guestName.trim(),
    guest_phone: input.guestPhone.trim() || null,
    parts: parts.map((p) => ({
      service_id: p.serviceId,
      provider_id: p.providerId,
      guest_name: p.guestName.trim() || null,
    })),
  };
}
