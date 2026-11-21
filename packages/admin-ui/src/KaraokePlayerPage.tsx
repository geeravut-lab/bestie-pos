import { useEffect, useRef, useState } from 'react';
import { parseKaraokeRooms, parseStaffSongs, pickPlayerStep } from '@bestie/core';
import type { StaffSong } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

// A small slice of YouTube's IFrame Player API (https://developers.google.com/youtube/iframe_api_reference): the official way to play a video inside a page.
type YtPlayer = {
  loadVideoById: (id: string) => void;
  playVideo: () => void;
  destroy: () => void;
};
type YtApi = {
  Player: new (
    el: HTMLElement | string,
    opts: {
      width?: string | number;
      height?: string | number;
      videoId?: string;
      playerVars?: Record<string, number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YtPlayer;
};
const YT_ENDED = 0;

/** Load the IFrame API once; resolves with `window.YT`. */
function loadYouTubeApi(): Promise<YtApi> {
  const w = window as unknown as {
    YT?: YtApi & { loaded?: number };
    onYouTubeIframeAPIReady?: () => void;
  };
  if (w.YT?.Player) return Promise.resolve(w.YT);
  return new Promise((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (w.YT?.Player) resolve(w.YT);
      else reject(new Error('yt'));
    };
    if (!document.querySelector('script[data-yt-api]')) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.dataset.ytApi = '1';
      s.onerror = () => reject(new Error('yt'));
      document.head.appendChild(s);
    }
  });
}

/**
 * The room's own player: one staff screen (a tablet / PC wired to the room's TV) that plays the song queue continuously with YouTube's official player.
 * The database holds the queue; this page only asks it what is playing, shows that video and, when it ends, marks it done and starts the next. A video that
 * cannot be embedded is skipped. Start it once with the button (browsers only allow sound after a tap).
 */
export function KaraokePlayerPage({ ctx, roomId }: { ctx: PageContext; roomId: string }) {
  const { t } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const [started, setStarted] = useState(false);
  const [apiFailed, setApiFailed] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [ready, setReady] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const shownRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const currentRef = useRef<StaffSong | null>(null);

  const data = useRemote<{ room: string | null; running: boolean; songs: StaffSong[] }>(
    async () => {
      if (!storeId) throw new Error('shop');
      const [room, session, songs] = await Promise.all([
        ctx.client
          .from('karaoke_rooms')
          .select('id, name, rate_per_hour, min_minutes, step_minutes, active, sort')
          .eq('id', roomId),
        ctx.client.from('karaoke_sessions').select('id').eq('room_id', roomId).is('ended_at', null),
        ctx.client
          .from('karaoke_songs')
          .select('id, room_id, video_id, title, status, source')
          .eq('room_id', roomId)
          .in('status', ['queued', 'playing'])
          .order('requested_at'),
      ]);
      if (room.error || songs.error) throw new Error('load');
      return {
        room: parseKaraokeRooms(room.data)[0]?.name ?? null,
        running: !session.error && Array.isArray(session.data) && session.data.length > 0,
        songs: parseStaffSongs(songs.data),
      };
    },
    roomId,
  );
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  useEffect(() => {
    const id = window.setInterval(reload, 5000);
    return () => window.clearInterval(id);
  }, [reload]);

  const call = async (fn: string, args: Record<string, unknown>) => {
    const r = await ctx.client.rpc(fn, args);
    reload();
    return !r.error;
  };
  const finish = async (status: 'done' | 'removed') => {
    const cur = currentRef.current;
    if (!cur || busyRef.current) return;
    busyRef.current = true;
    try {
      await call('karaoke_song_set', { p_song: cur.id, p_status: status });
    } finally {
      busyRef.current = false;
    }
  };

  // start the official player once, after the tap
  useEffect(() => {
    if (!started || playerRef.current || !hostRef.current) return;
    let alive = true;
    loadYouTubeApi().then(
      (YT) => {
        if (!alive || !hostRef.current || playerRef.current) return;
        const target = document.createElement('div');
        hostRef.current.appendChild(target);
        playerRef.current = new YT.Player(target, {
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
          events: {
            onStateChange: (e) => {
              if (e.data === YT_ENDED) void finish('done');
            },
            onError: () => {
              setSkipped(true);
              void finish('removed');
            },
          },
        });
        setReady(true);
      },
      () => alive && setApiFailed(true),
    );
    return () => {
      alive = false;
    };
    // `finish` only reads refs and the stable `call`; the player is created once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const songs = data.data?.songs ?? [];
  const step = pickPlayerStep(songs);
  useEffect(() => {
    currentRef.current = step.kind === 'play' ? step.song : null;
  });
  useEffect(() => {
    const p = playerRef.current;
    if (!started || !ready || !p || !data.data?.running) return;
    if (step.kind === 'play') {
      if (shownRef.current !== step.song.videoId + step.song.id) {
        shownRef.current = step.song.videoId + step.song.id;
        setSkipped(false);
        p.loadVideoById(step.song.videoId);
      }
    } else if (step.kind === 'start' && !busyRef.current) {
      busyRef.current = true;
      void call('karaoke_song_set', { p_song: step.song.id, p_status: 'playing' }).finally(() => {
        busyRef.current = false;
      });
    }
    // the step is derived from `data`; `call` is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, ready, data.data, step.kind, step.kind === 'idle' ? '' : step.song.id]);
  useEffect(
    () => () => {
      try {
        playerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
    },
    [],
  );

  if (data.status === 'loading') {
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  }
  if (data.status === 'error' || !data.data || data.data.room === null)
    return <Notice kind="error">{t.err_load_failed}</Notice>;
  const waiting = songs.filter((s) => s.status === 'queued');
  return (
    <div className="admin-page">
      <h1>{fmt(t.kplTitle, { room: data.data.room })}</h1>
      {!started ? (
        <div className="card admin-card">
          <p>{t.kplIntro}</p>
          <div className="actions">
            <AsyncButton onClick={async () => setStarted(true)}>{t.kplStart}</AsyncButton>
          </div>
        </div>
      ) : null}
      {apiFailed ? <Notice kind="error">{t.kplApiFailed}</Notice> : null}
      {started && !data.data.running ? <Notice kind="info">{t.kplNotRunning}</Notice> : null}
      {skipped ? <Notice kind="info">{t.kplSkipped}</Notice> : null}
      <div className="karaoke-player" ref={hostRef} />
      {started ? (
        <>
          <p>
            <strong>{t.krNowPlaying}:</strong>{' '}
            {step.kind === 'play' ? step.song.title : t.kplNothing}
          </p>
          <h2>{t.kplUpNext}</h2>
          {waiting.length === 0 ? <p className="muted">{t.krQueueEmpty}</p> : null}
          <ol>
            {waiting.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ol>
          <div className="actions">
            <AsyncButton variant="secondary" onClick={async () => void finish('done')}>
              {t.kplSkip}
            </AsyncButton>
          </div>
        </>
      ) : null}
    </div>
  );
}
