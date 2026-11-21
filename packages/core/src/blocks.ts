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

/**
 * Where a day off / break is drawn in a calendar column: percentages of the visible hours (`startMin`..`endMin`, minutes after Bangkok
 * midnight), for the day that starts at `dayFromIso`. Null when it does not touch the visible hours.
 */
export function blockSpan(
  block: { startsAt: string; endsAt: string },
  dayFromIso: string,
  startMin: number,
  endMin: number,
): { topPct: number; heightPct: number } | null {
  const day = Date.parse(dayFromIso);
  const a = (Date.parse(block.startsAt) - day) / 60_000;
  const b = (Date.parse(block.endsAt) - day) / 60_000;
  if (!Number.isFinite(a) || !Number.isFinite(b) || endMin <= startMin) return null;
  const from = Math.max(a, startMin);
  const to = Math.min(b, endMin);
  if (to <= from) return null;
  const span = endMin - startMin;
  return { topPct: ((from - startMin) / span) * 100, heightPct: ((to - from) / span) * 100 };
}

// ── weekly days off (they repeat by themselves) ─────────────────────────────

export type WeeklyOff = {
  id: string;
  resourceId: string;
  /** ISO weekday: 1 = Monday … 7 = Sunday (Bangkok). */
  weekday: number;
  from: string;
  /** null = until the end of the day */
  to: string | null;
  reason: string;
};

const hhmm = (v: unknown): string | null => {
  const m = /^(\d{2}):(\d{2})/.exec(typeof v === 'string' ? v : '');
  return m ? `${m[1]}:${m[2]}` : null;
};

/** Read `resource_weekly_offs` rows (the database gives times as HH:MM:SS). */
export function parseWeeklyOffs(raw: unknown): WeeklyOff[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): WeeklyOff[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const from = hhmm(o.from_time);
    const wd = Number(o.weekday);
    if (typeof o.id !== 'string' || typeof o.resource_id !== 'string' || !from) return [];
    if (!Number.isInteger(wd) || wd < 1 || wd > 7) return [];
    return [
      {
        id: o.id,
        resourceId: o.resource_id,
        weekday: wd,
        from,
        to: o.to_time == null ? null : hhmm(o.to_time),
        reason: typeof o.reason === 'string' ? o.reason : '',
      },
    ];
  });
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a Bangkok date "YYYY-MM-DD". */
export function isoWeekday(date: string): number | null {
  if (!DATE.test(date)) return null;
  const d = new Date(`${date}T00:00:00+07:00`);
  if (Number.isNaN(d.getTime())) return null;
  const bangkok = new Date(d.getTime() + 7 * 3_600_000);
  if (bangkok.toISOString().slice(0, 10) !== date) return null; // 30 February and friends roll over: not a date
  const js = bangkok.getUTCDay(); // 0 = Sunday in Bangkok
  return js === 0 ? 7 : js;
}

/** The weekly days off that fall on one Bangkok date, as ordinary blocks (so the calendar draws them like a one-off day off). */
export function weeklyOffsForDay(
  date: string,
  rows: readonly WeeklyOff[],
): { resourceId: string; startsAt: string; endsAt: string; reason: string }[] {
  const wd = isoWeekday(date);
  if (wd === null) return [];
  return rows
    .filter((r) => r.weekday === wd)
    .map((r) => ({
      resourceId: r.resourceId,
      startsAt: iso(instant(date, r.from)),
      endsAt: iso(r.to ? instant(date, r.to) : instant(date, '00:00') + DAY_MS),
      reason: r.reason,
    }));
}

/** The body of `save_weekly_off`; null for anything that is not valid. */
export function weeklyOffPayload(input: {
  storeId: string;
  resourceId: string;
  weekdays: readonly number[];
  allDay: boolean;
  timeFrom?: string;
  timeTo?: string;
  reason?: string;
}): Record<string, unknown> | null {
  const days = [...new Set(input.weekdays)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  if (days.length === 0 || !input.storeId || !input.resourceId) return null;
  if (!input.allDay) {
    if (!TIME.test(input.timeFrom ?? '') || !TIME.test(input.timeTo ?? '')) return null;
    if ((input.timeTo ?? '') <= (input.timeFrom ?? '')) return null;
  }
  return {
    store_id: input.storeId,
    resource_id: input.resourceId,
    weekdays: days.sort(),
    from_time: input.allDay ? null : input.timeFrom,
    to_time: input.allDay ? null : input.timeTo,
    reason: input.reason?.trim() || null,
  };
}
