// Karaoke profile (docs/KARAOKE-AI.md): room timer arithmetic, the song queue's inputs and what the pages read. Pure helpers only; the database decides.
// The billing arithmetic is mirrored by `karaoke_billed_minutes` / `karaoke_amount` in migration 70 and a test keeps both equal.

export const KARAOKE_STEPS = [1, 5, 10, 15, 30, 60] as const;
export type KaraokeStep = (typeof KARAOKE_STEPS)[number];
/** Songs a guest may leave waiting at once, and how long a finished song blocks the same song (docs/KARAOKE-AI.md). */
export const KARAOKE_GUEST_QUEUE_MAX = 3;
export const KARAOKE_REPEAT_MINUTES = 10;

/** Billed minutes = the elapsed time rounded UP to a whole step, never below the shortest time. */
export function karaokeBilledMinutes(
  elapsedSeconds: number,
  minMinutes: number,
  step: number,
): number {
  const secs = Math.max(0, Math.floor(elapsedSeconds));
  const stepSecs = 60 * step;
  return Math.max(minMinutes, Math.floor((secs + stepSecs - 1) / stepSecs) * step);
}

/** Amount in satang = rate per hour × minutes ÷ 60, rounded half up. Integers only. */
export function karaokeAmount(ratePerHour: number, minutes: number): number {
  return Math.floor((ratePerHour * minutes + 30) / 60);
}

/** Minutes beyond the package's included minutes, rounded UP to a whole step (0 while still inside the package). */
export function karaokeOverageMinutes(
  elapsedSeconds: number,
  includedMinutes: number,
  step: number,
): number {
  const secs = Math.max(0, Math.floor(elapsedSeconds));
  if (secs <= includedMinutes * 60) return 0;
  const stepSecs = 60 * step;
  return Math.floor((secs - includedMinutes * 60 + stepSecs - 1) / stepSecs) * step;
}

export type KaraokeSettlement = { billedMinutes: number; amount: number };
/**
 * What a room costs if it were stopped after `elapsedSeconds` (the screen's running estimate; the database fixes the real figure at the stop).
 * With package time (`includedMinutes` > 0): the packages' price plus the time beyond them at the room's rate; without: rate × time, shortest time, step.
 */
export function karaokeSettle(
  elapsedSeconds: number,
  room: {
    ratePerHour: number;
    minMinutes: number;
    stepMinutes: number;
    includedMinutes?: number;
    packageTotal?: number;
  },
): KaraokeSettlement {
  if ((room.includedMinutes ?? 0) > 0) {
    const over = karaokeOverageMinutes(elapsedSeconds, room.includedMinutes ?? 0, room.stepMinutes);
    return {
      billedMinutes: (room.includedMinutes ?? 0) + over,
      amount: (room.packageTotal ?? 0) + karaokeAmount(room.ratePerHour, over),
    };
  }
  const billedMinutes = karaokeBilledMinutes(elapsedSeconds, room.minMinutes, room.stepMinutes);
  return { billedMinutes, amount: karaokeAmount(room.ratePerHour, billedMinutes) };
}

/** 0:07:05 style clock for a room timer (hours are not capped). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ── addresses ────────────────────────────────────────────────────────────────
const ROOM_PATH = /^\/r\/([0-9a-f]{32})\/?$/;
export const karaokeTokenFromPath = (pathname: string): string | null =>
  ROOM_PATH.exec(pathname)?.[1] ?? null;
export const karaokeLink = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/r/${token}`;

// ── songs ────────────────────────────────────────────────────────────────────
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const isVideoId = (v: unknown): v is string => typeof v === 'string' && VIDEO_ID.test(v);

/**
 * The YouTube video id a guest pasted: a watch / short / embed / youtu.be link, or the bare 11-character id.
 * Anything else is null — a song is only ever a real video, never invented text.
 */
export function parseYoutubeId(text: string): string | null {
  const t = text.trim();
  if (VIDEO_ID.test(t)) return t;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return VIDEO_ID.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && VIDEO_ID.test(v)) return v;
    const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(url.pathname);
    return m ? m[1]! : null;
  }
  return null;
}

/** Is this text a link / id rather than words to search for? */
export const looksLikeYoutubeLink = (text: string): boolean => parseYoutubeId(text) !== null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export type SongHit = { videoId: string; title: string; channel: string };
/** Search results from our own server; anything without a real video id is dropped. */
export function parseSongHits(v: unknown): SongHit[] {
  if (!Array.isArray(v)) return [];
  const out: SongHit[] = [];
  for (const x of v.slice(0, 10)) {
    const o = obj(x);
    const videoId = str(o.videoId);
    const title = str(o.title).trim().slice(0, 150);
    if (!isVideoId(videoId) || !title) continue;
    out.push({ videoId, title, channel: str(o.channel).trim().slice(0, 80) });
  }
  return out;
}

export type QueueSong = {
  id: string;
  videoId: string;
  title: string;
  status: 'queued' | 'playing';
};
export type KaraokeRoomView = {
  shop: string;
  room: string;
  songsEnabled: boolean;
  running: boolean;
  paused: boolean;
  /** Minutes of package time the room has bought (null = pay per use). */
  includedMinutes: number | null;
  elapsedSeconds: number;
  queue: QueueSong[];
};
/** What the guest page reads (`guest_karaoke_room`). */
export function parseKaraokeRoomView(v: unknown): KaraokeRoomView | null {
  const o = obj(v);
  if (!str(o.room)) return null;
  const queue: QueueSong[] = [];
  if (Array.isArray(o.queue)) {
    for (const x of o.queue) {
      const g = obj(x);
      const status = g.status === 'playing' ? 'playing' : g.status === 'queued' ? 'queued' : null;
      if (!status || !str(g.id) || !isVideoId(g.video_id)) continue;
      queue.push({ id: str(g.id), videoId: g.video_id, title: str(g.title), status });
    }
  }
  return {
    shop: str(o.shop),
    room: str(o.room),
    songsEnabled: o.songs_enabled === true,
    running: o.running === true,
    paused: o.paused === true,
    includedMinutes: typeof o.included_minutes === 'number' ? o.included_minutes : null,
    elapsedSeconds: num(o.elapsed_seconds),
    queue,
  };
}

export type KaraokeAddError = 'unavailable' | 'invalid' | 'not_in_use' | 'rate' | 'full' | 'repeat';
export const KARAOKE_ADD_ERRORS: readonly KaraokeAddError[] = [
  'unavailable',
  'invalid',
  'not_in_use',
  'rate',
  'full',
  'repeat',
];
export const asAddError = (v: unknown): KaraokeAddError | null =>
  (KARAOKE_ADD_ERRORS as readonly unknown[]).includes(v) ? (v as KaraokeAddError) : null;

// ── staff screens ────────────────────────────────────────────────────────────
export type KaraokeRoom = {
  id: string;
  name: string;
  ratePerHour: number;
  minMinutes: number;
  stepMinutes: number;
  active: boolean;
  sort: number;
};
export function parseKaraokeRooms(v: unknown): KaraokeRoom[] {
  if (!Array.isArray(v)) return [];
  const out: KaraokeRoom[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!str(o.id) || !str(o.name)) continue;
    out.push({
      id: str(o.id),
      name: str(o.name),
      ratePerHour: num(o.rate_per_hour),
      minMinutes: num(o.min_minutes),
      stepMinutes: num(o.step_minutes) || 15,
      active: o.active !== false,
      sort: num(o.sort),
    });
  }
  return out.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export type KaraokeSession = {
  id: string;
  roomId: string;
  startedAt: string;
  endedAt: string | null;
  guests: number | null;
  ratePerHour: number;
  minMinutes: number;
  stepMinutes: number;
  billedMinutes: number | null;
  amount: number | null;
  orderId: string | null;
  pausedAt: string | null;
  pausedSeconds: number;
  includedMinutes: number;
  packageTotal: number;
  packageName: string | null;
  bookingId: string | null;
};

/** Seconds counted so far on the screen's clock: start → (stop | pause | now), minus the time spent paused. The database's own figure is the real one. */
export function sessionElapsedSeconds(s: KaraokeSession, nowMs: number): number {
  const end = s.endedAt ? Date.parse(s.endedAt) : s.pausedAt ? Date.parse(s.pausedAt) : nowMs;
  return Math.max(0, Math.floor((end - Date.parse(s.startedAt)) / 1000) - s.pausedSeconds);
}
export function parseKaraokeSessions(v: unknown): KaraokeSession[] {
  if (!Array.isArray(v)) return [];
  const out: KaraokeSession[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!str(o.id) || !str(o.room_id) || !str(o.started_at)) continue;
    out.push({
      id: str(o.id),
      roomId: str(o.room_id),
      startedAt: str(o.started_at),
      endedAt: str(o.ended_at) || null,
      guests: typeof o.guests === 'number' ? o.guests : null,
      ratePerHour: num(o.rate_per_hour),
      minMinutes: num(o.min_minutes),
      stepMinutes: num(o.step_minutes) || 15,
      billedMinutes: typeof o.billed_minutes === 'number' ? o.billed_minutes : null,
      amount: typeof o.amount === 'number' ? o.amount : null,
      orderId: str(o.order_id) || null,
      pausedAt: str(o.paused_at) || null,
      pausedSeconds: num(o.paused_seconds),
      includedMinutes: num(o.included_minutes),
      packageTotal: num(o.package_total),
      packageName: str(o.package_name) || null,
      bookingId: str(o.booking_id) || null,
    });
  }
  return out;
}

export type StaffSong = {
  id: string;
  roomId: string;
  videoId: string;
  title: string;
  status: 'queued' | 'playing' | 'done' | 'removed';
  source: 'guest' | 'staff';
};
export function parseStaffSongs(v: unknown): StaffSong[] {
  if (!Array.isArray(v)) return [];
  const out: StaffSong[] = [];
  for (const x of v) {
    const o = obj(x);
    const status = ['queued', 'playing', 'done', 'removed'].includes(str(o.status))
      ? (str(o.status) as StaffSong['status'])
      : null;
    if (!status || !str(o.id) || !isVideoId(o.video_id)) continue;
    out.push({
      id: str(o.id),
      roomId: str(o.room_id),
      videoId: o.video_id,
      title: str(o.title),
      status,
      source: o.source === 'staff' ? 'staff' : 'guest',
    });
  }
  return out;
}

// ── the in-room player (staff screen `/karaoke/player/<room>`) ───────────────
const PLAYER_PATH =
  /^\/karaoke\/player\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
export const karaokePlayerRoomFromPath = (pathname: string): string | null =>
  PLAYER_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;

export type PlayerStep =
  | { kind: 'play'; song: StaffSong } // the database says this song is playing: make sure the player shows it
  | { kind: 'start'; song: StaffSong } // nothing is playing: mark the first waiting song as playing
  | { kind: 'idle' };

/** What the player should do next, from the room's songs (oldest first). The database is the one source of truth: the player never keeps its own queue. */
export function pickPlayerStep(songs: readonly StaffSong[]): PlayerStep {
  const playing = songs.find((s) => s.status === 'playing');
  if (playing) return { kind: 'play', song: playing };
  const next = songs.find((s) => s.status === 'queued');
  return next ? { kind: 'start', song: next } : { kind: 'idle' };
}

// ── packages and reservations ────────────────────────────────────────────────
export type KaraokePackage = {
  id: string;
  name: string;
  minutes: number;
  price: number;
  active: boolean;
  sort: number;
};
export function parseKaraokePackages(v: unknown): KaraokePackage[] {
  if (!Array.isArray(v)) return [];
  const out: KaraokePackage[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!str(o.id) || !str(o.name) || num(o.minutes) <= 0) continue;
    out.push({
      id: str(o.id),
      name: str(o.name),
      minutes: num(o.minutes),
      price: num(o.price),
      active: o.active !== false,
      sort: num(o.sort),
    });
  }
  return out.sort((a, b) => a.sort - b.sort || a.minutes - b.minutes);
}

export const KARAOKE_BOOKING_STATUSES = [
  'booked',
  'arrived',
  'cancelled',
  'no_show',
  'done',
] as const;
export type KaraokeBookingStatus = (typeof KARAOKE_BOOKING_STATUSES)[number];
export type KaraokeBooking = {
  id: string;
  roomId: string;
  guestName: string;
  phone: string | null;
  guests: number | null;
  startsAt: string;
  endsAt: string;
  status: KaraokeBookingStatus;
  note: string | null;
  /** Made by the guest on the booking link (`online`) or at the counter. */
  source: 'counter' | 'online';
  /** Deposit asked for, satang (online bookings; 0 = none). */
  depositDue: number;
  /** An online booking is released at this time when the deposit has not arrived. */
  holdUntil: string | null;
};
export function parseKaraokeBookings(v: unknown): KaraokeBooking[] {
  if (!Array.isArray(v)) return [];
  const out: KaraokeBooking[] = [];
  for (const x of v) {
    const o = obj(x);
    const status = (KARAOKE_BOOKING_STATUSES as readonly string[]).includes(str(o.status))
      ? (str(o.status) as KaraokeBookingStatus)
      : null;
    if (!status || !str(o.id) || !str(o.room_id) || !str(o.starts_at) || !str(o.ends_at)) continue;
    out.push({
      id: str(o.id),
      roomId: str(o.room_id),
      guestName: str(o.guest_name),
      phone: str(o.phone) || null,
      guests: typeof o.guests === 'number' ? o.guests : null,
      startsAt: str(o.starts_at),
      endsAt: str(o.ends_at),
      status,
      note: str(o.note) || null,
      source: o.source === 'online' ? 'online' : 'counter',
      depositDue: typeof o.deposit_due === 'number' && o.deposit_due > 0 ? o.deposit_due : 0,
      holdUntil: str(o.hold_until) || null,
    });
  }
  return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** Does a new reservation [start, end) clash with a live one of the same room? (The database refuses it too; this lets the screen warn first.) */
export function bookingClash(
  existing: readonly KaraokeBooking[],
  roomId: string,
  startMs: number,
  endMs: number,
): KaraokeBooking | null {
  return (
    existing.find(
      (b) =>
        b.roomId === roomId &&
        (b.status === 'booked' || b.status === 'arrived') &&
        Date.parse(b.startsAt) < endMs &&
        Date.parse(b.endsAt) > startMs,
    ) ?? null
  );
}
