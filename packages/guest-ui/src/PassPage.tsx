import { useEffect, useState } from 'react';
import { guestName, passLink } from '@bestie/core';
import type { Pass } from '@bestie/core';
import { GUEST_LANGS, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, LangSwitch, QrSvg, Spinner } from '@bestie/ui';
import { PrintArea } from './PrintArea';
import { IslandShops } from './IslandShops';
import { PassPartners } from './PassPartners';
import { loadPass, loadPassWallet } from './networkApi';
import type { Loaded } from './networkApi';

/** The guest's Tourist Pass (`/pass/<token>`): QR + code for the cashier, her network points, recent movements and the island's shops. */
export function PassPage({ token }: { token: string }) {
  const { t, lang } = useI18n();
  const [load, setLoad] = useState<Loaded<Pass> | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const id = window.setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 60);
    return () => window.clearTimeout(id);
  }, [printing]);
  useEffect(() => {
    let alive = true;
    void loadPassWallet(token).then((u) => alive && setWallet(u));
    return () => {
      alive = false;
    };
  }, [token]);
  useEffect(() => {
    let alive = true;
    void loadPass(token).then((r) => alive && setLoad(r));
    return () => {
      alive = false;
    };
  }, [token]);

  const head = (
    <div className="guest-head">
      <h1>{load?.ok ? guestName(load.data.network.name, lang) : t.npTitle}</h1>
      <LangSwitch langs={GUEST_LANGS} />
    </div>
  );
  if (!load)
    return (
      <>
        {head}
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      </>
    );
  if (!load.ok)
    return (
      <>
        {head}
        <p role="alert">{load.reason === 'not_found' ? t.npNotFound : t.npFailed}</p>
      </>
    );
  const p = load.data;
  const kind = (k: string): string =>
    k === 'earn' || k === 'reverse_redeem' ? t.npEarn : k === 'redeem' ? t.npRedeem : t.npOther;
  return (
    <>
      {head}
      <section className="card pass-card" aria-label={t.npTitle}>
        <h2>{fmt(t.npHello, { name: p.name })}</h2>
        <div className="pass-qr">
          <QrSvg value={passLink(globalThis.location?.origin ?? '', token)} label={t.npQrAlt} />
        </div>
        <p className="muted">{t.npShowCashier}</p>
        <p>
          {t.npCodeLabel}: <strong className="mono pass-code">{p.code}</strong>
        </p>
        <div className="actions">
          <AsyncButton variant="secondary" onClick={async () => setPrinting(true)}>
            {t.npPrintCard}
          </AsyncButton>
          {wallet ? (
            <a className="btn btn-secondary" href={wallet}>
              {t.npWallet}
            </a>
          ) : null}
        </div>
        {printing ? (
          <PrintArea pageCss="@page { size: 85.6mm 54mm; margin: 0 }">
            <div className="pass-print">
              <div className="pass-print-text">
                <strong>{guestName(p.network.name, lang)}</strong>
                <span>{t.npTitle}</span>
                <span className="pass-print-name">{p.name}</span>
                <span className="mono">{p.code}</span>
                <span className="pass-print-note">{t.npShowCashier}</span>
              </div>
              <QrSvg value={passLink(globalThis.location?.origin ?? '', token)} label={t.npQrAlt} />
            </div>
          </PrintArea>
        ) : null}
      </section>
      <section className="card" aria-label={t.npPoints}>
        <h2>{t.npPoints}</h2>
        <p className="pass-points">{p.points.toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB')}</p>
        <p className="muted">{t.npPointsNote}</p>
        <h3>{t.npHistory}</h3>
        {p.activity.length === 0 ? <p className="muted">{t.npNoHistory}</p> : null}
        <ul className="pass-history">
          {p.activity.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span>
                {kind(a.kind)} · {a.shop}
              </span>
              <strong>{a.points > 0 ? `+${a.points}` : a.points}</strong>
              <span className="muted">{formatDateTime(lang, a.at)}</span>
            </li>
          ))}
        </ul>
        <p className="muted">{t.npKeepPrivate}</p>
      </section>
      <PassPartners token={token} />
      <section aria-label={t.npShops}>
        <h2>{t.npShops}</h2>
        <IslandShops shops={p.shops} />
      </section>
    </>
  );
}
