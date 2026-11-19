import { useEffect, useRef, useState } from 'react';
import { fmt, useI18n } from '@bestie/i18n';
import type { Printer } from '@bestie/core';
import { Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { Page, Loading } from '../PosBits';
import { usePosStore } from '../posData';
import { supportedKinds } from './drivers';
import { ticketPrinters } from './kitchenPrint';
import { printStationTick } from './station';
import type { StationResult } from './station';

const POLL_MS = 5000;
const key = (storeId: string) => `bestie-print-station:${storeId}`;
const readServed = (storeId: string): string[] => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(key(storeId)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * A print station: a tablet / PC at the shop that stays open and prints the kitchen / bar tickets of orders the SERVER sent to the
 * kitchen by itself (guest QR auto-send), on the ticket printers this screen can reach. Tickets from tablets are printed by the tablet.
 */
export function PrintStationPage({ ctx, pollMs = POLL_MS }: { ctx: PageContext; pollMs?: number }) {
  const { t } = useI18n();
  const { storeId } = usePosStore(ctx);
  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [served, setServed] = useState<string[]>(() => (storeId ? readServed(storeId) : []));
  const [log, setLog] = useState<StationResult[]>([]);
  const kinds = supportedKinds();
  const busy = useRef(false);

  useEffect(() => {
    if (!storeId) return;
    let alive = true;
    ticketPrinters(ctx.client, storeId).then(
      (p) => alive && setPrinters(p),
      () => alive && setPrinters([]),
    );
    return () => {
      alive = false;
    };
  }, [ctx.client, storeId]);

  // keep the screen awake while this page is open (best effort; not every browser has it)
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = globalThis.navigator as unknown as {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock?.request('screen').then(
      (l) => (lock = l),
      () => {},
    );
    return () => void lock?.release().catch(() => {});
  }, []);

  const servedPrinters = (printers ?? []).filter((p) => served.includes(p.id) && kinds[p.kind]);
  useEffect(() => {
    if (!storeId || servedPrinters.length === 0) return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await printStationTick({ client: ctx.client, storeId, served: servedPrinters });
        if (r.length > 0) setLog((cur) => [...r, ...cur].slice(0, 10));
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const i = setInterval(() => void tick(), pollMs);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- servedPrinters is derived from printers + served
  }, [ctx.client, storeId, printers, served, pollMs]);

  if (!storeId)
    return (
      <Page title={t.stationTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (printers === null) return <Loading />;

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...served, id] : served.filter((x) => x !== id);
    setServed(next);
    try {
      globalThis.localStorage?.setItem(key(storeId), JSON.stringify(next));
    } catch {
      /* the choice just does not stick */
    }
  };

  return (
    <Page title={t.stationTitle}>
      <Notice kind="info">{t.stationIntro}</Notice>
      {printers.length === 0 ? <Notice kind="info">{t.ticketNoPrinter}</Notice> : null}
      <ul className="member-list">
        {printers.map((p) => (
          <li key={p.id} className="member-row">
            <label className="check-row">
              <input
                type="checkbox"
                checked={served.includes(p.id)}
                disabled={!kinds[p.kind]}
                onChange={(e) => toggle(p.id, e.target.checked)}
              />
              <span>
                {p.name} · {(t as Record<string, string>)[`printerKind_${p.kind}`]}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {servedPrinters.length > 0 ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.stationWaiting}
        </p>
      ) : (
        <Notice kind="info">{t.stationPickPrinter}</Notice>
      )}
      {log.length > 0 ? (
        <ul className="muted" aria-label={t.stationLog}>
          {log.map((r) => (
            <li key={r.jobId}>
              {fmt(r.ok ? t.stationPrinted : t.stationFailed, {
                number: r.orderNumber,
                name: r.printer.name,
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
