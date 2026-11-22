import { useEffect, useState } from 'react';
import { formatTHB, guestName } from '@bestie/core';
import type { LocalizedText } from '@bestie/core';
import { useI18n } from '@bestie/i18n';

/**
 * The customer-facing second screen. The cashier's tablet posts what is on the bill to a BroadcastChannel; the second window
 * (`/display`, opened from the order screen and put on the customer's monitor) draws it. Same device, same browser: it needs no network
 * and no server, so it works offline too, and nothing about the customer ever leaves the tablet.
 */
export const DISPLAY_CHANNEL = 'bestie-display';
export type DisplayMsg =
  | {
      kind: 'bill';
      number: string;
      lines: { name: LocalizedText; qty: number; amount: number }[];
      total: number;
      pointsDiscount: number;
    }
  | { kind: 'thanks'; number: string; total: number }
  | { kind: 'idle' };

export function postDisplay(msg: DisplayMsg): void {
  try {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch {
    /* a display that cannot be reached must never disturb selling */
  }
}

/** Keep the second screen in step with the order being worked on (and clear it when the order screen closes). */
export function useDisplayFeed(msg: DisplayMsg | null): void {
  const key = JSON.stringify(msg);
  useEffect(() => {
    if (msg) postDisplay(msg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => postDisplay({ kind: 'idle' }), []);
}

/** Mount it anywhere in a screen: it posts `msg` whenever it changes and clears the second screen when the screen closes. */
export function DisplayFeed({ msg }: { msg: DisplayMsg | null }) {
  useDisplayFeed(msg);
  return null;
}

const valid = (m: unknown): m is DisplayMsg =>
  !!m &&
  typeof m === 'object' &&
  ['bill', 'thanks', 'idle'].includes(String((m as { kind?: unknown }).kind));

export function CustomerDisplayPage() {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const [msg, setMsg] = useState<DisplayMsg>({ kind: 'idle' });
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    ch.onmessage = (e: MessageEvent) => {
      if (valid(e.data)) setMsg(e.data);
    };
    return () => ch.close();
  }, []);
  if (typeof BroadcastChannel === 'undefined')
    return (
      <div className="display-screen">
        <p role="alert">{t.cdUnsupported}</p>
      </div>
    );
  if (msg.kind === 'idle')
    return (
      <div className="display-screen display-idle" role="status">
        <h1>{t.cdWelcome}</h1>
      </div>
    );
  if (msg.kind === 'thanks')
    return (
      <div className="display-screen display-thanks" role="status">
        <h1>{t.cdThanks}</h1>
        <p className="display-total tabular">{formatTHB(msg.total, locale)}</p>
      </div>
    );
  return (
    <div className="display-screen" aria-live="polite">
      <h1>{t.cdYourOrder}</h1>
      <ul className="display-lines">
        {msg.lines.map((l, i) => (
          <li key={i}>
            <span>
              {l.qty} × {guestName(l.name, lang)}
            </span>
            <span className="tabular">{formatTHB(l.amount, locale)}</span>
          </li>
        ))}
      </ul>
      {msg.pointsDiscount > 0 ? (
        <p className="muted tabular">
          {t.previewPoints}: −{formatTHB(msg.pointsDiscount, locale)}
        </p>
      ) : null}
      <p className="display-total tabular">
        {t.previewTotal}: <strong>{formatTHB(msg.total, locale)}</strong>
      </p>
    </div>
  );
}
