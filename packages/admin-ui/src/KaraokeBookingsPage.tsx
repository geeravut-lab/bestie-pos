import { useState } from 'react';
import {
  addDays,
  bangkokDate,
  bangkokParts,
  bookingClash,
  parseKaraokeBookings,
  parseKaraokeRooms,
  timeLabel,
} from '@bestie/core';
import type { KaraokeBooking, KaraokeRoom } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

type Draft = {
  roomId: string;
  time: string;
  minutes: string;
  name: string;
  phone: string;
  guests: string;
  note: string;
};

/** Karaoke room reservations (`/karaoke/bookings`): the day's bookings per room, a form to book ahead, and "Start the room" when the guests arrive. */
export function KaraokeBookingsPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canRun = ctx.isOwner || ctx.permissions.includes('order.create');
  const [day, setDay] = useState(() => bangkokDate(Date.now()));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const data = useRemote<{ rooms: KaraokeRoom[]; bookings: KaraokeBooking[] }>(async () => {
    if (!storeId) throw new Error('shop');
    // the day, and the day before / after so a reservation across midnight still shows and still blocks
    const from = `${addDays(day, -1)}T00:00:00+07:00`;
    const to = `${addDays(day, 2)}T00:00:00+07:00`;
    const [rooms, bookings] = await Promise.all([
      ctx.client
        .from('karaoke_rooms')
        .select('id, name, rate_per_hour, min_minutes, step_minutes, active, sort')
        .eq('store_id', storeId)
        .order('sort'),
      ctx.client
        .from('karaoke_bookings')
        .select('id, room_id, guest_name, phone, guests, starts_at, ends_at, status, note')
        .eq('store_id', storeId)
        .gte('starts_at', from)
        .lt('starts_at', to)
        .order('starts_at'),
    ]);
    if (rooms.error || bookings.error) throw new Error('load');
    return { rooms: parseKaraokeRooms(rooms.data), bookings: parseKaraokeBookings(bookings.data) };
  }, `${storeId}:${day}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  if (!storeId) return <Notice kind="error">{t.err_load_failed}</Notice>;
  const d = data.data;
  const todays = (d?.bookings ?? []).filter((b) => bangkokParts(b.startsAt).date === day);
  const span = (b: KaraokeBooking) =>
    `${timeLabel(bangkokParts(b.startsAt).minutes)}–${timeLabel(bangkokParts(b.endsAt).minutes)}`;

  const fail = (code?: string) =>
    setMsg(
      code === '23P01'
        ? t.kbBusy
        : code === '42501'
          ? t.err_forbidden
          : code === '22023'
            ? t.kbInvalid
            : t.err_save_failed,
    );
  const status = (b: KaraokeBooking, s: 'cancelled' | 'no_show') => async () => {
    setMsg(null);
    const r = await ctx.client.rpc('karaoke_booking_status', { p_booking: b.id, p_status: s });
    if (r.error) return fail(r.error.code);
    reload();
  };
  const startRoom = (b: KaraokeBooking) => async () => {
    setMsg(null);
    const r = await ctx.client.rpc('karaoke_start', {
      p_room: b.roomId,
      p_guests: b.guests,
      p_booking: b.id,
    });
    if (r.error) return fail(r.error.code);
    ctx.navigate('/karaoke');
  };
  const save = async () => {
    if (!draft) return;
    const mins = Number.parseInt(draft.minutes, 10);
    const startMs = Date.parse(`${day}T${draft.time}:00+07:00`);
    if (
      !draft.roomId ||
      !draft.name.trim() ||
      !/^\d{2}:\d{2}$/.test(draft.time) ||
      !(mins >= 15 && mins <= 720) ||
      !Number.isFinite(startMs)
    )
      return setMsg(t.kbInvalid);
    const clash = bookingClash(d?.bookings ?? [], draft.roomId, startMs, startMs + mins * 60_000);
    if (clash) return setMsg(fmt(t.kbClash, { name: clash.guestName, time: span(clash) }));
    setMsg(null);
    const guests = Number.parseInt(draft.guests, 10);
    const r = await ctx.client.rpc('karaoke_book', {
      p: {
        store_id: storeId,
        room_id: draft.roomId,
        guest_name: draft.name.trim(),
        phone: draft.phone.trim() || null,
        guests: Number.isFinite(guests) ? guests : null,
        starts_at: new Date(startMs).toISOString(),
        minutes: mins,
        note: draft.note.trim() || null,
      },
    });
    if (r.error) return fail(r.error.code);
    setDraft(null);
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.kbTitle}</h1>
      <Notice kind="info">{t.kbIntro}</Notice>
      {msg ? <Notice kind="error">{msg}</Notice> : null}
      <div className="form-row">
        <label className="label" htmlFor="kb-day">
          {t.kbDay}
        </label>
        <input
          id="kb-day"
          className="field"
          type="date"
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
        />
      </div>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d && todays.length === 0 ? <p className="muted">{t.kbNone}</p> : null}
      {(d?.rooms ?? []).map((room) => {
        const list = todays.filter((b) => b.roomId === room.id);
        if (list.length === 0) return null;
        return (
          <section key={room.id} className="card admin-card" aria-label={room.name}>
            <h2>{room.name}</h2>
            <ul className="member-list">
              {list.map((b) => (
                <li key={b.id} className="member-row">
                  <div className="member-head">
                    <strong className="mono">{span(b)}</strong>
                    <span>{b.guestName}</span>
                    {b.guests ? <span className="muted">{b.guests}</span> : null}
                    <span className="badge">{tx(t, `kbStatus_${b.status}`)}</span>
                  </div>
                  {b.phone || b.note ? (
                    <p className="muted">{[b.phone, b.note].filter(Boolean).join(' · ')}</p>
                  ) : null}
                  {canRun && b.status === 'booked' ? (
                    <div className="actions">
                      <AsyncButton onClick={startRoom(b)}>{t.kbStartRoom}</AsyncButton>
                      <AsyncButton variant="secondary" onClick={status(b, 'cancelled')}>
                        {t.kbCancel}
                      </AsyncButton>
                      {Date.parse(b.startsAt) <= Date.now() ? (
                        <AsyncButton variant="secondary" onClick={status(b, 'no_show')}>
                          {t.kbNoShow}
                        </AsyncButton>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {draft ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.kbAdd}
        >
          <div className="form-row">
            <label className="label" htmlFor="kb-room">
              {t.kbRoom}
            </label>
            <select
              id="kb-room"
              className="field"
              value={draft.roomId}
              onChange={(e) => setDraft({ ...draft, roomId: e.target.value })}
            >
              {(d?.rooms ?? [])
                .filter((r) => r.active)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kb-time">
              {t.kbTime}
            </label>
            <input
              id="kb-time"
              className="field"
              type="time"
              value={draft.time}
              onChange={(e) => setDraft({ ...draft, time: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kb-min">
              {t.kbMinutes}
            </label>
            <input
              id="kb-min"
              className="field"
              inputMode="numeric"
              value={draft.minutes}
              onChange={(e) => setDraft({ ...draft, minutes: e.target.value.replace(/\D/g, '') })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kb-name">
              {t.kbGuestName}
            </label>
            <input
              id="kb-name"
              className="field"
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kb-phone">
              {t.kbPhone}
            </label>
            <input
              id="kb-phone"
              className="field"
              inputMode="tel"
              maxLength={30}
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kb-guests">
              {t.kbGuests}
            </label>
            <input
              id="kb-guests"
              className="field"
              inputMode="numeric"
              maxLength={3}
              value={draft.guests}
              onChange={(e) => setDraft({ ...draft, guests: e.target.value.replace(/\D/g, '') })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kb-note">
              {t.kbNote}
            </label>
            <input
              id="kb-note"
              className="field"
              maxLength={300}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>
          <div className="actions">
            <AsyncButton type="submit" onClick={save}>
              {t.kbSave}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : canRun ? (
        <div className="actions">
          <AsyncButton
            variant="secondary"
            onClick={async () =>
              setDraft({
                roomId: d?.rooms.find((r) => r.active)?.id ?? '',
                time: '18:00',
                minutes: '120',
                name: '',
                phone: '',
                guests: '',
                note: '',
              })
            }
          >
            {t.kbAdd}
          </AsyncButton>
        </div>
      ) : null}
    </div>
  );
}
