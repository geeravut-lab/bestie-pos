import { useEffect, useState } from 'react';
import { bangkokDate, kitchenTickets, localizedName, pickupList, queueBoard } from '@bestie/core';
import type { Station, Ticket } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useOnline, useShopOrders } from '@bestie/offline';
import { primeSound, useNewIds } from './chime';
import { bumpLines } from './orderActions';
import { usePosData, usePosStore } from './posData';
import { LoadFailed, Loading, Page } from './PosBits';

/** The current time, refreshed every `ms`, so ages and colours keep moving while the screen stays open. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now;
}

/** Orders of the last two days are enough for a kitchen / queue view (a bill is paid the same day). */
function useSince(): string {
  const [d] = useState(() => bangkokDate(Date.now() - 36 * 3_600_000));
  return d;
}

const channelText = (t: Record<string, string>, c: string): string =>
  t[`channel_${c.replace('-', '_')}`] ?? c;

function TicketCard({
  ticket,
  tableName,
  action,
  actionLabel,
  secondary,
}: {
  ticket: Ticket;
  tableName: string | undefined;
  action: () => Promise<unknown>;
  actionLabel: string;
  secondary?: boolean;
}) {
  const { t, lang } = useI18n();
  const dict = t as unknown as Record<string, string>;
  return (
    <article
      className="ticket"
      data-age={ticket.age}
      aria-label={fmt(t.kdsTicketFor, { number: ticket.number })}
    >
      <header className="ticket-head">
        <strong className="ticket-number tabular">{ticket.number}</strong>
        <span>
          {tableName ? fmt(t.orderAtTable, { name: tableName }) : channelText(dict, ticket.channel)}
        </span>
        <span className="ticket-age tabular">{fmt(t.kdsMinutes, { n: ticket.ageMinutes })}</span>
      </header>
      <ul className="ticket-lines">
        {ticket.lines.map((l) => (
          <li key={l.id}>
            <span className="ticket-qty tabular">{l.quantity}×</span>
            <span>
              <strong>{localizedName(l.name, lang)}</strong>
              {l.options.length > 0 ? (
                <small> {l.options.map((o) => localizedName(o, lang)).join(', ')}</small>
              ) : null}
              {l.note ? <em className="ticket-note"> — {l.note}</em> : null}
            </span>
          </li>
        ))}
      </ul>
      <AsyncButton
        variant={secondary ? 'secondary' : 'primary'}
        className="ticket-action"
        onClick={action}
      >
        {actionLabel}
      </AsyncButton>
    </article>
  );
}

/** Kitchen / bar screen: what to make (oldest first, colour by waiting time), what is ready. Bumping works offline. */
export function KitchenPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { storeId, binding } = usePosStore(ctx);
  const remote = usePosData(ctx, storeId, 10_000);
  const since = useSince();
  const orders = useShopOrders(storeId, since);
  const online = useOnline();
  const now = useNow(15_000);
  const [pick, setPick] = useState<Station | 'all' | null>(null);
  const [sound, setSound] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const station: Station | null | undefined =
    binding?.role === 'kds'
      ? binding.station
      : pick === null
        ? undefined
        : pick === 'all'
          ? null
          : pick;

  const incomingIds =
    station === undefined || !orders
      ? []
      : kitchenTickets(orders, station, now).incoming.map((x) => x.id);
  useNewIds(incomingIds, sound);

  if (!storeId)
    return (
      <Page title={t.kdsTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (remote.status === 'loading' || orders === undefined) return <Loading />;
  if (remote.status === 'error' || !remote.data) return <LoadFailed onRetry={remote.reload} />;

  if (station === undefined) {
    return (
      <Page title={t.kdsTitle}>
        <p>{t.kdsPickStation}</p>
        <div className="chips" role="group" aria-label={t.kdsPickStation}>
          {(['kitchen', 'bar', 'all'] as const).map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setPick(s)}>
              {s === 'all'
                ? t.kdsStationAll
                : s === 'kitchen'
                  ? t.deviceStation_kitchen
                  : t.deviceStation_bar}
            </button>
          ))}
        </div>
      </Page>
    );
  }

  const { incoming, ready } = kitchenTickets(orders, station, now);
  const tableName = (id: string | null) => remote.data!.tables.find((x) => x.id === id)?.name;
  const bump = async (ids: string[], status: 'ready' | 'sent') => {
    setError(null);
    const err = await bumpLines({ storeId, lineIds: ids, status, sinceDate: since });
    if (err) setError(err);
  };

  return (
    <Page
      title={`${t.kdsTitle} · ${station === null ? t.kdsStationAll : station === 'kitchen' ? t.deviceStation_kitchen : t.deviceStation_bar}`}
    >
      {!online ? <Notice kind="info">{t.kdsOffline}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={sound}
          onClick={() => {
            if (!sound) primeSound();
            setSound(!sound);
          }}
        >
          {sound ? t.kdsSoundOff : t.kdsSoundOn}
        </button>
      </div>
      <section aria-label={t.kdsIncoming}>
        <h2>
          {t.kdsIncoming} <span className="badge">{incoming.length}</span>
        </h2>
        {incoming.length === 0 ? <p className="muted">{t.kdsEmpty}</p> : null}
        <div className="ticket-grid">
          {incoming.map((x) => (
            <TicketCard
              key={x.id}
              ticket={x}
              tableName={tableName(x.tableId)}
              actionLabel={t.kdsBump}
              action={() =>
                bump(
                  x.lines.map((l) => l.id),
                  'ready',
                )
              }
            />
          ))}
        </div>
      </section>
      <section aria-label={t.kdsReady}>
        <h2>
          {t.kdsReady} <span className="badge">{ready.length}</span>
        </h2>
        <div className="ticket-grid">
          {ready.map((x) => (
            <TicketCard
              key={x.id}
              ticket={x}
              tableName={tableName(x.tableId)}
              actionLabel={t.kdsUndo}
              secondary
              action={() =>
                bump(
                  x.lines.map((l) => l.id),
                  'sent',
                )
              }
            />
          ))}
        </div>
      </section>
    </Page>
  );
}

/** Waiter: what is ready to carry out, per bill and table; "Served" clears it. */
export function ReadyPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { storeId } = usePosStore(ctx);
  const remote = usePosData(ctx, storeId, 10_000);
  const since = useSince();
  const orders = useShopOrders(storeId, since);
  const now = useNow(15_000);
  const [error, setError] = useState<ErrorKey | null>(null);
  const ids = orders ? pickupList(orders, now).map((x) => x.id) : [];
  useNewIds(ids, true);

  if (!storeId)
    return (
      <Page title={t.readyTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (remote.status === 'loading' || orders === undefined) return <Loading />;
  if (remote.status === 'error' || !remote.data) return <LoadFailed onRetry={remote.reload} />;
  const list = pickupList(orders, now);
  const tableName = (id: string | null) => remote.data!.tables.find((x) => x.id === id)?.name;
  return (
    <Page title={t.readyTitle}>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {list.length === 0 ? <p className="muted">{t.readyNone}</p> : null}
      <div className="ticket-grid">
        {list.map((x) => (
          <TicketCard
            key={x.id}
            ticket={x}
            tableName={tableName(x.tableId)}
            actionLabel={t.readyServed}
            action={async () => {
              setError(null);
              const err = await bumpLines({
                storeId,
                lineIds: x.lines.map((l) => l.id),
                status: 'served',
                sinceDate: since,
              });
              if (err) setError(err);
            }}
          />
        ))}
      </div>
    </Page>
  );
}

/** Cafe queue: staff view with "Handed over" buttons, and a link to the big customer-facing call screen. */
export function QueuePage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { storeId } = usePosStore(ctx);
  const remote = usePosData(ctx, storeId, 10_000);
  const since = useSince();
  const orders = useShopOrders(storeId, since);
  const [error, setError] = useState<ErrorKey | null>(null);
  if (!storeId)
    return (
      <Page title={t.queueTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (remote.status === 'loading' || orders === undefined) return <Loading />;
  if (remote.status === 'error' || !remote.data) return <LoadFailed onRetry={remote.reload} />;
  const board = queueBoard(orders);
  const handOver = async (orderId: string) => {
    setError(null);
    const o = orders.find((x) => x.id === orderId);
    const ids = o ? o.lines.filter((l) => l.status === 'ready').map((l) => l.id) : [];
    const err = await bumpLines({ storeId, lineIds: ids, status: 'served', sinceDate: since });
    if (err) setError(err);
  };
  return (
    <Page title={t.queueTitle}>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton variant="secondary" onClick={() => ctx.navigate('/queue/display')}>
          {t.queueOpenDisplay}
        </AsyncButton>
      </div>
      <div className="queue-columns">
        <section className="card admin-card" aria-label={t.queuePreparing}>
          <h2>{t.queuePreparing}</h2>
          {board.preparing.length === 0 ? <p className="muted">{t.queueNone}</p> : null}
          <ul className="queue-list">
            {board.preparing.map((e) => (
              <li key={e.orderId}>
                <strong className="queue-number tabular">{e.number}</strong>
              </li>
            ))}
          </ul>
        </section>
        <section className="card admin-card" aria-label={t.queueReady}>
          <h2>{t.queueReady}</h2>
          {board.ready.length === 0 ? <p className="muted">{t.queueNone}</p> : null}
          <ul className="queue-list">
            {board.ready.map((e) => (
              <li key={e.orderId}>
                <strong className="queue-number tabular">{e.number}</strong>
                <AsyncButton variant="secondary" onClick={() => handOver(e.orderId)}>
                  {t.queueHandOver}
                </AsyncButton>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Page>
  );
}

/** The customer-facing call screen: only big numbers, a chime when a new number becomes ready. */
export function QueueDisplayPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { storeId } = usePosStore(ctx);
  const remote = usePosData(ctx, storeId, 5_000);
  const since = useSince();
  const orders = useShopOrders(storeId, since);
  const [sound, setSound] = useState(false);
  const readyIds = orders ? queueBoard(orders).ready.map((e) => e.orderId) : [];
  useNewIds(readyIds, sound);
  if (!storeId)
    return (
      <Page title={t.queueTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (remote.status === 'loading' || orders === undefined) return <Loading />;
  if (remote.status === 'error' || !remote.data) return <LoadFailed onRetry={remote.reload} />;
  const board = queueBoard(orders);
  return (
    <div className="queue-display" aria-label={t.queueTitle}>
      <div className="actions no-print">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void document.documentElement.requestFullscreen?.()}
        >
          {t.queueFullscreen}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={sound}
          onClick={() => {
            if (!sound) primeSound();
            setSound(!sound);
          }}
        >
          {sound ? t.kdsSoundOff : t.kdsSoundOn}
        </button>
      </div>
      <div className="queue-columns queue-columns-big">
        <section aria-label={t.queuePreparing}>
          <h2>{t.queuePreparing}</h2>
          <ul className="queue-list queue-list-big">
            {board.preparing.map((e) => (
              <li key={e.orderId} className="queue-number tabular">
                {e.number}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label={t.queueReady} className="queue-ready-col">
          <h2>{t.queueReady}</h2>
          <p className="muted">{t.queueCollect}</p>
          <ul className="queue-list queue-list-big">
            {board.ready.map((e) => (
              <li key={e.orderId} className="queue-number queue-number-ready tabular">
                {e.number}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
