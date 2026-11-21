import { useEffect, useState } from 'react';
import {
  formatClock,
  formatTHB,
  karaokeLink,
  karaokeSettle,
  parseKaraokePackages,
  sessionElapsedSeconds,
  KARAOKE_STEPS,
  parseKaraokeRooms,
  parseKaraokeSessions,
  parseStaffSongs,
  parsePriceInput,
  priceInputValue,
} from '@bestie/core';
import type { KaraokePackage, KaraokeRoom, KaraokeSession, StaffSong } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, QrSvg, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';
import { KaraokeBridgePanel } from './KaraokeBridgePanel';
import { useRemote } from './useRemote';

type Loaded = {
  rooms: KaraokeRoom[];
  sessions: KaraokeSession[];
  songs: StaffSong[];
  tills: { id: string }[];
  packages: KaraokePackage[];
};
type Draft = {
  id: string | null;
  name: string;
  rate: string;
  min: string;
  step: number;
  active: boolean;
};
const NEW_ROOM: Draft = { id: null, name: '', rate: '', min: '60', step: 15, active: true };

/** Karaoke rooms (module `karaoke.rooms`): start / stop the room timer, bill the time as an ordinary bill, and run the song queue. */
export function KaraokePage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canRun = ctx.isOwner || ctx.permissions.includes('order.create');
  const songsOn = ctx.isModuleOn ? ctx.isModuleOn('karaoke.songs') : true;
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [guests, setGuests] = useState<Record<string, string>>({});
  const [pick, setPick] = useState<Record<string, string>>({});
  const [pkgDraft, setPkgDraft] = useState<{
    id: string | null;
    name: string;
    minutes: string;
    price: string;
    active: boolean;
  } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [printRoom, setPrintRoom] = useState<string | null>(null);

  const data = useRemote<Loaded>(async () => {
    if (!storeId) throw new Error('shop');
    const [rooms, sessions, songs, devs, pkgs] = await Promise.all([
      ctx.client
        .from('karaoke_rooms')
        .select('id, name, rate_per_hour, min_minutes, step_minutes, active, sort')
        .eq('store_id', storeId)
        .order('sort')
        .order('name'),
      ctx.client
        .from('karaoke_sessions')
        .select(
          'id, room_id, started_at, ended_at, guests, rate_per_hour, min_minutes, step_minutes, billed_minutes, amount, order_id, paused_at, paused_seconds, included_minutes, package_total, package_name, booking_id',
        )
        .eq('store_id', storeId)
        .order('started_at', { ascending: false })
        .limit(60),
      ctx.client
        .from('karaoke_songs')
        .select('id, room_id, video_id, title, status, source')
        .eq('store_id', storeId)
        .in('status', ['queued', 'playing'])
        .order('requested_at'),
      ctx.client
        .from('devices')
        .select('id')
        .eq('store_id', storeId)
        .eq('active', true)
        .eq('role', 'cashier')
        .order('name'),
      ctx.client
        .from('karaoke_packages')
        .select('id, name, minutes, price, active, sort')
        .eq('store_id', storeId)
        .order('sort'),
    ]);
    if (rooms.error) throw new Error('load');
    return {
      rooms: parseKaraokeRooms(rooms.data),
      sessions: sessions.error ? [] : parseKaraokeSessions(sessions.data),
      songs: songs.error ? [] : parseStaffSongs(songs.data),
      tills: devs.error ? [] : ((devs.data ?? []) as { id: string }[]),
      packages: pkgs.error ? [] : parseKaraokePackages(pkgs.data),
    };
  }, storeId ?? '');
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const running = (data.data?.sessions ?? []).some((s) => !s.endedAt);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  useEffect(() => {
    if (printRoom === null) return;
    const id = window.setTimeout(() => {
      window.print();
      setPrintRoom(null);
    }, 60);
    return () => window.clearTimeout(id);
  }, [printRoom]);

  if (!storeId) return <Notice kind="error">{t.err_load_failed}</Notice>;
  const d = data.data;
  const fail = (code: string | undefined) =>
    setMsg({
      kind: 'error',
      text:
        code === '42501'
          ? t.err_forbidden
          : code === '55000'
            ? t.karBusy
            : code === '22023'
              ? t.karNothingToBill
              : t.err_save_failed,
    });
  const call = async (fn: string, args: Record<string, unknown>) => {
    setMsg(null);
    const r = await ctx.client.rpc(fn, args);
    if (r.error) {
      fail(r.error.code);
      return null;
    }
    reload();
    return r.data;
  };

  const start = (room: KaraokeRoom) => async () => {
    const n = Number.parseInt(guests[room.id] ?? '', 10);
    await call('karaoke_start', {
      p_room: room.id,
      p_guests: Number.isFinite(n) && n >= 1 && n <= 200 ? n : null,
      p_package: pick[`start-${room.id}`] || null,
    });
  };
  const pause = (s: KaraokeSession) => async () => {
    await call(s.pausedAt ? 'karaoke_resume' : 'karaoke_pause', { p_session: s.id });
  };
  const extend = (s: KaraokeSession) => async () => {
    const id = pick[`extend-${s.id}`] || d?.packages.find((x) => x.active)?.id;
    if (id) await call('karaoke_extend', { p_session: s.id, p_package: id });
  };
  const savePackage = async () => {
    if (!pkgDraft) return;
    const price = parsePriceInput(pkgDraft.price || '');
    const minutes = Number.parseInt(pkgDraft.minutes, 10);
    if (!pkgDraft.name.trim() || price === null || !(minutes >= 15 && minutes <= 600)) {
      setMsg({ kind: 'error', text: t.karPackageInvalid });
      return;
    }
    setMsg(null);
    const r = await ctx.client.rpc('save_karaoke_package', {
      p: {
        store_id: storeId,
        id: pkgDraft.id,
        name: pkgDraft.name.trim(),
        minutes,
        price,
        active: pkgDraft.active,
      },
    });
    if (r.error) {
      setMsg({
        kind: 'error',
        text:
          r.error.code === '23505' || r.error.code === '23514'
            ? t.karPackageInvalid
            : t.err_save_failed,
      });
      return;
    }
    setPkgDraft(null);
    reload();
  };
  const stop = (s: KaraokeSession) => async () => {
    await call('karaoke_stop', { p_session: s.id });
  };
  const openBill = (s: KaraokeSession) => async () => {
    const id = await call('karaoke_to_order', {
      p_session: s.id,
      p_device: d?.tills[0]?.id ?? null,
    });
    if (typeof id === 'string') ctx.navigate(`/order/${id}`);
  };
  const setSong = (g: StaffSong, status: 'playing' | 'done' | 'removed') => async () => {
    await call('karaoke_song_set', { p_song: g.id, p_status: status });
  };
  const saveRoom = async () => {
    if (!draft) return;
    const rate = parsePriceInput(draft.rate || '');
    const min = Number.parseInt(draft.min, 10);
    if (
      !draft.name.trim() ||
      draft.name.trim().length > 60 ||
      rate === null ||
      !(min >= 0 && min <= 600)
    ) {
      setMsg({ kind: 'error', text: t.karRoomInvalid });
      return;
    }
    setMsg(null);
    const r = await ctx.client.rpc('save_karaoke_room', {
      p: {
        store_id: storeId,
        id: draft.id,
        name: draft.name.trim(),
        rate_per_hour: rate,
        min_minutes: min,
        step_minutes: draft.step,
        active: draft.active,
      },
    });
    if (r.error) {
      setMsg({
        kind: 'error',
        text:
          r.error.code === '23505' || r.error.code === '23514'
            ? t.karRoomInvalid
            : t.err_save_failed,
      });
      return;
    }
    setDraft(null);
    reload();
  };
  const loadLinks = async (rotate?: string) => {
    const r = await ctx.client.rpc('karaoke_room_links', {
      p_store: storeId,
      p_rotate: rotate ?? null,
    });
    if (r.error) return fail(r.error.code);
    const next: Record<string, string> = {};
    for (const x of (Array.isArray(r.data) ? r.data : []) as { id?: string; token?: string }[])
      if (x.id && x.token) next[x.id] = x.token;
    setLinks(next);
    if (rotate) setMsg({ kind: 'info', text: t.karQrNewDone });
  };

  const origin = globalThis.location?.origin ?? '';
  return (
    <div className="admin-page">
      <h1>{t.karTitle}</h1>
      <Notice kind="info">{t.karIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d && d.rooms.length === 0 ? <p className="muted">{t.karNoRooms}</p> : null}
      <ul className="member-list">
        {(d?.rooms ?? []).map((room) => {
          const mine = (d?.sessions ?? []).filter((s) => s.roomId === room.id);
          const live = mine.find((s) => !s.endedAt);
          const last = mine.find((s) => s.endedAt);
          const songs = (d?.songs ?? []).filter((g) => g.roomId === room.id);
          const elapsed = live ? sessionElapsedSeconds(live, now) : 0;
          const est = live
            ? karaokeSettle(elapsed, {
                ratePerHour: live.ratePerHour,
                minMinutes: live.minMinutes,
                stepMinutes: live.stepMinutes,
                includedMinutes: live.includedMinutes,
                packageTotal: live.packageTotal,
              })
            : null;
          const left =
            live && live.includedMinutes > 0 ? live.includedMinutes * 60 - elapsed : null;
          return (
            <li key={room.id} className="member-row">
              <div className="member-head">
                <strong>{room.name}</strong>
                <span className="badge">
                  {live ? t.karInUse : room.active ? t.karFree : t.karInactive}
                </span>
                <span className="muted">
                  {money(room.ratePerHour)} / {t.karHour}
                </span>
              </div>
              {live && est ? (
                <>
                  <p>
                    {t.karElapsed}: <strong className="mono">{formatClock(elapsed)}</strong>
                    {live.guests ? ` · ${live.guests}` : ''}
                    {live.pausedAt ? <span className="badge badge-warn">{t.karPaused}</span> : null}
                  </p>
                  {left !== null ? (
                    <p>
                      {live.packageName ? `${live.packageName} · ` : ''}
                      {fmt(t.karIncluded, { n: live.includedMinutes })} ·{' '}
                      <strong>
                        {left >= 0
                          ? fmt(t.karTimeLeft, { time: formatClock(left) })
                          : fmt(t.karOver, { time: formatClock(-left) })}
                      </strong>
                    </p>
                  ) : null}
                  <p>
                    {t.karEstimate}: <strong>{money(est.amount)}</strong> (
                    {fmt(t.karBilledLine, { n: est.billedMinutes })})
                  </p>
                  <p className="muted">{t.karMoneyNote}</p>
                  {canRun ? (
                    <div className="actions">
                      <AsyncButton variant="secondary" onClick={pause(live)}>
                        {live.pausedAt ? t.karResume : t.karPause}
                      </AsyncButton>
                      <AsyncButton onClick={stop(live)}>{t.karStop}</AsyncButton>
                    </div>
                  ) : null}
                  {canRun && (d?.packages.some((x) => x.active) ?? false) ? (
                    <div className="form-row">
                      <label className="label" htmlFor={`kar-x-${live.id}`}>
                        {t.karExtendPick}
                      </label>
                      <select
                        id={`kar-x-${live.id}`}
                        className="field"
                        value={pick[`extend-${live.id}`] ?? ''}
                        onChange={(e) =>
                          setPick({ ...pick, [`extend-${live.id}`]: e.target.value })
                        }
                      >
                        {(d?.packages ?? [])
                          .filter((x) => x.active)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name} · {x.minutes} · {money(x.price)}
                            </option>
                          ))}
                      </select>
                      <AsyncButton variant="secondary" onClick={extend(live)}>
                        {t.karExtend}
                      </AsyncButton>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  {canRun && room.active ? (
                    <div className="form-row">
                      <label className="label" htmlFor={`kar-g-${room.id}`}>
                        {t.karGuests}
                      </label>
                      <input
                        id={`kar-g-${room.id}`}
                        className="field"
                        inputMode="numeric"
                        maxLength={3}
                        value={guests[room.id] ?? ''}
                        onChange={(e) =>
                          setGuests({ ...guests, [room.id]: e.target.value.replace(/\D/g, '') })
                        }
                      />
                      {(d?.packages.some((x) => x.active) ?? false) ? (
                        <>
                          <label className="label" htmlFor={`kar-p-${room.id}`}>
                            {t.karPackage}
                          </label>
                          <select
                            id={`kar-p-${room.id}`}
                            className="field"
                            value={pick[`start-${room.id}`] ?? ''}
                            onChange={(e) =>
                              setPick({ ...pick, [`start-${room.id}`]: e.target.value })
                            }
                          >
                            <option value="">{t.karNoPackage}</option>
                            {(d?.packages ?? [])
                              .filter((x) => x.active)
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name} · {x.minutes} · {money(x.price)}
                                </option>
                              ))}
                          </select>
                        </>
                      ) : null}
                      <AsyncButton onClick={start(room)}>{t.karStart}</AsyncButton>
                    </div>
                  ) : null}
                  {last && last.amount !== null && last.billedMinutes !== null ? (
                    <p className="muted">
                      {t.karLast}:{' '}
                      {fmt(t.karSessionLine, { n: last.billedMinutes, amount: money(last.amount) })}
                      {canRun && last.amount > 0 ? (
                        <>
                          {' '}
                          <AsyncButton variant="secondary" onClick={openBill(last)}>
                            {t.karOpenBill}
                          </AsyncButton>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </>
              )}
              {songsOn ? (
                <>
                  <h3>{t.karQueue}</h3>
                  {canRun ? (
                    <div className="actions">
                      <AsyncButton
                        variant="secondary"
                        onClick={async () => ctx.navigate(`/karaoke/player/${room.id}`)}
                      >
                        {t.karOpenPlayer}
                      </AsyncButton>
                    </div>
                  ) : null}
                  {songs.length === 0 ? <p className="muted">{t.karNoSongs}</p> : null}
                  <ul className="member-list">
                    {songs.map((g) => (
                      <li key={g.id} className="member-row">
                        <div className="member-head">
                          <span className="badge">
                            {g.status === 'playing' ? t.karPlaying : t.karWaiting}
                          </span>
                          <span>{g.title}</span>
                          <a
                            className="link-button"
                            href={`https://www.youtube.com/watch?v=${g.videoId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t.karOpenVideo}
                          </a>
                        </div>
                        {canRun ? (
                          <div className="actions">
                            {g.status === 'queued' ? (
                              <AsyncButton variant="secondary" onClick={setSong(g, 'playing')}>
                                {t.karPlay}
                              </AsyncButton>
                            ) : (
                              <AsyncButton variant="secondary" onClick={setSong(g, 'done')}>
                                {t.karSongDone}
                              </AsyncButton>
                            )}
                            <AsyncButton variant="secondary" onClick={setSong(g, 'removed')}>
                              {t.karSongRemove}
                            </AsyncButton>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {canEdit ? (
                <div className="actions">
                  <AsyncButton
                    variant="secondary"
                    onClick={async () =>
                      setDraft({
                        id: room.id,
                        name: room.name,
                        rate: priceInputValue(room.ratePerHour),
                        min: String(room.minMinutes),
                        step: room.stepMinutes,
                        active: room.active,
                      })
                    }
                  >
                    {t.karEditRoom}
                  </AsyncButton>
                  {songsOn ? (
                    <AsyncButton variant="secondary" onClick={() => loadLinks()}>
                      {t.karQrTitle}
                    </AsyncButton>
                  ) : null}
                </div>
              ) : null}
              {canEdit && songsOn ? (
                <KaraokeBridgePanel ctx={ctx} storeId={storeId} roomId={room.id} />
              ) : null}
              {links[room.id] ? (
                <div className="card admin-card">
                  <QrSvg value={karaokeLink(origin, links[room.id]!)} label={t.karQrTitle} />
                  <p className="mono muted">{karaokeLink(origin, links[room.id]!)}</p>
                  <div className="actions">
                    <AsyncButton variant="secondary" onClick={async () => setPrintRoom(room.id)}>
                      {t.karQrPrint}
                    </AsyncButton>
                    <AsyncButton variant="secondary" onClick={() => loadLinks(room.id)}>
                      {t.karQrNew}
                    </AsyncButton>
                  </div>
                  {printRoom === room.id ? (
                    <PrintPortal pageCss="@page { size: A5; margin: 10mm; }">
                      <div className="booking-poster">
                        <h1>{room.name}</h1>
                        <QrSvg value={karaokeLink(origin, links[room.id]!)} label={t.karQrTitle} />
                        <h2>{t.karQrPosterHint}</h2>
                      </div>
                    </PrintPortal>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!songsOn ? <p className="muted">{t.karSongsOff}</p> : null}
      {canRun ? (
        <div className="actions">
          <AsyncButton variant="secondary" onClick={async () => ctx.navigate('/karaoke/bookings')}>
            {t.karBookings}
          </AsyncButton>
        </div>
      ) : null}
      <section className="card admin-card" aria-label={t.karPackagesTitle}>
        <h2>{t.karPackagesTitle}</h2>
        <p className="muted">{t.karPackagesIntro}</p>
        <ul className="member-list">
          {(d?.packages ?? []).map((x) => (
            <li key={x.id} className="member-row">
              <div className="member-head">
                <strong>{x.name}</strong>
                <span>
                  {x.minutes} · {money(x.price)}
                </span>
                {!x.active ? <span className="muted">{t.karInactive}</span> : null}
              </div>
              {canEdit ? (
                <div className="actions">
                  <AsyncButton
                    variant="secondary"
                    onClick={async () =>
                      setPkgDraft({
                        id: x.id,
                        name: x.name,
                        minutes: String(x.minutes),
                        price: priceInputValue(x.price),
                        active: x.active,
                      })
                    }
                  >
                    {t.karEditRoom}
                  </AsyncButton>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {pkgDraft ? (
          <form
            className="auth-form"
            onSubmit={(e) => e.preventDefault()}
            aria-label={t.karAddPackage}
          >
            <div className="form-row">
              <label className="label" htmlFor="kar-pk-name">
                {t.karPackageName}
              </label>
              <input
                id="kar-pk-name"
                className="field"
                maxLength={60}
                value={pkgDraft.name}
                onChange={(e) => setPkgDraft({ ...pkgDraft, name: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="kar-pk-min">
                {t.karPackageMinutes}
              </label>
              <input
                id="kar-pk-min"
                className="field"
                inputMode="numeric"
                value={pkgDraft.minutes}
                onChange={(e) =>
                  setPkgDraft({ ...pkgDraft, minutes: e.target.value.replace(/\D/g, '') })
                }
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="kar-pk-price">
                {t.karPackagePrice}
              </label>
              <input
                id="kar-pk-price"
                className="field"
                inputMode="decimal"
                value={pkgDraft.price}
                onChange={(e) => setPkgDraft({ ...pkgDraft, price: e.target.value })}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={pkgDraft.active}
                onChange={(e) => setPkgDraft({ ...pkgDraft, active: e.target.checked })}
              />{' '}
              {t.karActive}
            </label>
            <div className="actions">
              <AsyncButton type="submit" onClick={savePackage}>
                {t.karPackageSave}
              </AsyncButton>
              <button type="button" className="btn btn-secondary" onClick={() => setPkgDraft(null)}>
                {t.menuCancel}
              </button>
            </div>
          </form>
        ) : canEdit ? (
          <div className="actions">
            <AsyncButton
              variant="secondary"
              onClick={async () =>
                setPkgDraft({ id: null, name: '', minutes: '60', price: '', active: true })
              }
            >
              {t.karAddPackage}
            </AsyncButton>
          </div>
        ) : null}
      </section>
      {draft ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.karEditRoom}
        >
          <div className="form-row">
            <label className="label" htmlFor="kar-name">
              {t.karRoomName}
            </label>
            <input
              id="kar-name"
              className="field"
              maxLength={60}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kar-rate">
              {t.karRate}
            </label>
            <input
              id="kar-rate"
              className="field"
              inputMode="decimal"
              value={draft.rate}
              onChange={(e) => setDraft({ ...draft, rate: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kar-min">
              {t.karMin}
            </label>
            <input
              id="kar-min"
              className="field"
              inputMode="numeric"
              value={draft.min}
              onChange={(e) => setDraft({ ...draft, min: e.target.value.replace(/\D/g, '') })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kar-step">
              {t.karStep}
            </label>
            <select
              id="kar-step"
              className="field"
              value={draft.step}
              onChange={(e) => setDraft({ ...draft, step: Number(e.target.value) })}
            >
              {KARAOKE_STEPS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            />{' '}
            {t.karActive}
          </label>
          <div className="actions">
            <AsyncButton type="submit" onClick={saveRoom}>
              {t.karSaveRoom}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : canEdit ? (
        <div className="actions">
          <AsyncButton variant="secondary" onClick={async () => setDraft({ ...NEW_ROOM })}>
            {t.karAddRoom}
          </AsyncButton>
        </div>
      ) : null}
    </div>
  );
}
