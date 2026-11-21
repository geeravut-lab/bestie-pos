import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock, parseYoutubeId } from '@bestie/core';
import type { KaraokeAddError, KaraokeRoomView, SongHit } from '@bestie/core';
import { GUEST_LANGS, fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton, LangSwitch, Spinner } from '@bestie/ui';
import {
  addKaraokeSong,
  loadKaraokeRoom,
  removeKaraokeSong,
  searchKaraokeSongs,
} from './karaokeApi';
import type { RoomLoad } from './karaokeApi';
import { listenOnce, voiceSupported } from './voice';

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(16).padStart(8, '0')}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;

const errorText = (t: Dict, e: KaraokeAddError | 'rate_limited' | 'failed'): string =>
  e === 'full'
    ? t.krErrFull
    : e === 'repeat'
      ? t.krErrRepeat
      : e === 'invalid'
        ? t.krErrInvalid
        : e === 'not_in_use'
          ? t.krErrNotInUse
          : e === 'rate' || e === 'rate_limited'
            ? t.krErrRate
            : e === 'unavailable'
              ? t.krErrUnavailable
              : t.krErrFailed;

/** The room page a guest reaches by the QR at the room (`/r/<token>`): the room clock, the song queue, a search by typing or by voice, and a link box. */
export function KaraokePage({ token }: { token: string }) {
  const { t, lang } = useI18n();
  const [load, setLoad] = useState<RoomLoad | null>(null);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [words, setWords] = useState('');
  const [hits, setHits] = useState<SongHit[] | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const stopVoice = useRef<(() => void) | null>(null);
  const attempt = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    const r = await loadKaraokeRoom(token);
    setLoad(r);
    setFetchedAt(Date.now());
  }, [token]);
  useEffect(() => {
    let alive = true;
    void loadKaraokeRoom(token).then((r) => {
      if (!alive) return;
      setLoad(r);
      setFetchedAt(Date.now());
    });
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      stopVoice.current?.();
    };
  }, [refresh, token]);

  const head = (room?: KaraokeRoomView) => (
    <div className="guest-head">
      <h1>{room ? fmt(t.krRoom, { room: room.room }) : t.krLoading}</h1>
      <LangSwitch langs={GUEST_LANGS} />
    </div>
  );
  if (!load)
    return (
      <>
        {head()}
        <p className="sso-working" role="status">
          <Spinner /> {t.krLoading}
        </p>
      </>
    );
  if (!load.ok)
    return (
      <>
        {head()}
        <p role="alert">{load.reason === 'not_found' ? t.krNotFound : t.krFailed}</p>
      </>
    );
  const room = load.room;
  const canAdd = room.songsEnabled && room.running;
  const elapsed = room.running ? room.elapsedSeconds + Math.max(0, (now - fetchedAt) / 1000) : 0;

  const add = async (source: string) => {
    setNote(null);
    // one id per song per try: the same tap sent twice never queues twice
    const key = source;
    const cid = attempt.current.get(key) ?? newId();
    attempt.current.set(key, cid);
    const r = await addKaraokeSong(token, source, cid);
    if (r.ok) {
      attempt.current.delete(key);
      setNote({ kind: 'ok', text: `${t.krAdded}: ${r.title}` });
      setLink('');
      await refresh();
    } else {
      if (r.error !== 'failed' && r.error !== 'rate_limited') attempt.current.delete(key);
      setNote({ kind: 'bad', text: errorText(t, r.error) });
    }
  };
  const search = async (text: string = words) => {
    setNote(null);
    setSearchNote(null);
    const q = text.trim();
    if (q.length < 2) return;
    if (parseYoutubeId(q)) {
      setHits(null);
      return add(q); // a pasted link in the search box is added as it is
    }
    const r = await searchKaraokeSongs(token, q);
    if (r.ok) {
      setHits(r.songs);
      if (r.songs.length === 0) setSearchNote(t.krNoResults);
    } else {
      setHits(null);
      setSearchNote(
        r.reason === 'no_key'
          ? t.krNoKey
          : r.reason === 'quota'
            ? t.krQuota
            : r.reason === 'rate'
              ? t.krErrRate
              : t.krFailed,
      );
    }
  };
  const talk = () => {
    setVoiceNote(null);
    if (!voiceSupported()) return setVoiceNote(t.krVoiceNone);
    setListening(true);
    stopVoice.current = listenOnce(
      lang,
      (text) => {
        setWords(text);
        void search(text);
      },
      (heard) => {
        setListening(false);
        if (!heard) setVoiceNote(t.krVoiceFailed);
      },
    );
  };

  return (
    <>
      {head(room)}
      <section className="card" aria-label={t.krTime}>
        <p className="muted">{room.shop}</p>
        {room.running ? (
          <p>
            {t.krTime}: <strong className="mono">{formatClock(elapsed)}</strong>
          </p>
        ) : (
          <p role="status">{t.krNotRunning}</p>
        )}
        {!room.songsEnabled ? <p className="muted">{t.krSongsOff}</p> : null}
      </section>

      {canAdd ? (
        <section className="card" aria-label={t.krSearch}>
          <h2>{t.krSearch}</h2>
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <div className="form-row">
              <label className="label" htmlFor="kr-q">
                {t.krSearchPlaceholder}
              </label>
              <input
                id="kr-q"
                className="field"
                maxLength={80}
                value={words}
                placeholder={t.krSearchPlaceholder}
                onChange={(e) => setWords(e.target.value)}
              />
            </div>
            <div className="actions">
              <AsyncButton type="submit" onClick={() => search()}>
                {t.krSearchBtn}
              </AsyncButton>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={talk}
                disabled={listening}
                aria-live="polite"
              >
                {listening ? t.krListening : t.krVoice}
              </button>
            </div>
          </form>
          {voiceNote ? <p role="status">{voiceNote}</p> : null}
          {searchNote ? <p role="status">{searchNote}</p> : null}
          {hits && hits.length > 0 ? (
            <>
              <ul className="member-list">
                {hits.map((h) => (
                  <li key={h.videoId} className="member-row">
                    <div className="member-head">
                      <span>{h.title}</span>
                      {h.channel ? <span className="muted">{h.channel}</span> : null}
                    </div>
                    <div className="actions">
                      <AsyncButton variant="secondary" onClick={() => add(h.videoId)}>
                        {t.krAdd}
                      </AsyncButton>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="muted">{t.krSource}</p>
            </>
          ) : null}
          <h3>{t.krPaste}</h3>
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim()) void add(link.trim());
            }}
          >
            <div className="form-row">
              <label className="label" htmlFor="kr-link">
                {t.krPaste}
              </label>
              <input
                id="kr-link"
                className="field"
                inputMode="url"
                maxLength={300}
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
            </div>
            <div className="actions">
              <AsyncButton
                type="submit"
                onClick={async () => (link.trim() ? add(link.trim()) : undefined)}
              >
                {t.krPasteBtn}
              </AsyncButton>
            </div>
          </form>
          {note ? <p role={note.kind === 'bad' ? 'alert' : 'status'}>{note.text}</p> : null}
        </section>
      ) : null}

      <section className="card" aria-label={t.krQueue}>
        <h2>{t.krQueue}</h2>
        {room.queue.length === 0 ? <p className="muted">{t.krQueueEmpty}</p> : null}
        <ol className="pass-history">
          {room.queue.map((g) => (
            <li key={g.id}>
              <span>
                {g.status === 'playing' ? <strong>{t.krNowPlaying}: </strong> : null}
                {g.title}
              </span>
              {g.status === 'queued' ? (
                <AsyncButton
                  variant="secondary"
                  onClick={async () => {
                    await removeKaraokeSong(token, g.id);
                    await refresh();
                  }}
                >
                  {t.krRemove}
                </AsyncButton>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
