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

export type KaraokeSettlement = { billedMinutes: number; amount: number };
/** What a room costs if it were stopped after `elapsedSeconds` (the screen's running estimate; the database fixes the real figure at the stop). */
export function karaokeSettle(
  elapsedSeconds: number,
  room: { ratePerHour: number; minMinutes: number; stepMinutes: number },
): KaraokeSettlement {
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
};
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
