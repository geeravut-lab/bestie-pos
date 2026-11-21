import { useState } from 'react';
import {
  NETWORK_CATEGORIES,
  clearingTotals,
  formatTHB,
  islandLink,
  joinLink,
  passLink,
} from '@bestie/core';
import type { ClearingLine, NetworkCategory } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, QrSvg, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Net = { id: string; slug: string; nameTh: string; nameEn: string };
type Listing = {
  category: NetworkCategory;
  titleTh: string;
  titleEn: string;
  aboutTh: string;
  aboutEn: string;
  visible: boolean;
};
type Loaded = { nets: Net[]; joined: string[]; listing: Listing | null };
type Row = ClearingLine & { issuerOrg: string; redeemerOrg: string };
type Issued = { token: string; code: string; name: string };

const CAT_KEY: Record<NetworkCategory, keyof Dict> = {
  food: 'niCatFood',
  cafe: 'niCatCafe',
  beauty: 'niCatBeauty',
  spa: 'niCatSpa',
  stay: 'niCatStay',
  shop: 'niCatShop',
  tour: 'niCatTour',
  other: 'niCatOther',
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const today = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const monthStart = (): string => `${today().slice(0, 8)}01`;
const EMPTY: Listing = {
  category: 'food',
  titleTh: '',
  titleEn: '',
  aboutTh: '',
  aboutEn: '',
  visible: true,
};

/** The island network (Phase 3): join, list the shop, guest links, issue a pass at the counter, and the points clearing statement. */
export function NetworkPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canIssue = ctx.isOwner || ctx.permissions.includes('order.create');
  const canReport = ctx.isOwner || ctx.permissions.includes('report.view');
  const [draft, setDraft] = useState<Listing | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [note, setNote] = useState<'saved' | 'failed' | 'copied' | 'bad' | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<Row[] | null>(null);

  const data = useRemote<Loaded>(
    async () => {
      const nets = await ctx.client.from('networks').select('id, slug, name').eq('active', true);
      const mem = await ctx.client
        .from('network_orgs')
        .select('network_id, left_at')
        .eq('org_id', ctx.orgId);
      if (nets.error || mem.error) throw new Error('load');
      let listing: Listing | null = null;
      if (storeId) {
        const l = await ctx.client
          .from('network_listings')
          .select('category, title, about, visible')
          .eq('store_id', storeId)
          .maybeSingle();
        if (!l.error && l.data) {
          const r = l.data as Record<string, unknown>;
          const title = (r.title ?? {}) as Record<string, unknown>;
          const about = (r.about ?? {}) as Record<string, unknown>;
          listing = {
            category: (NETWORK_CATEGORIES as readonly string[]).includes(str(r.category))
              ? (str(r.category) as NetworkCategory)
              : 'other',
            titleTh: str(title.th),
            titleEn: str(title.en),
            aboutTh: str(about.th),
            aboutEn: str(about.en),
            visible: r.visible !== false,
          };
        }
      }
      return {
        nets: ((nets.data ?? []) as Record<string, unknown>[]).map((n) => {
          const nm = (n.name ?? {}) as Record<string, unknown>;
          return { id: str(n.id), slug: str(n.slug), nameTh: str(nm.th), nameEn: str(nm.en) };
        }),
        joined: ((mem.data ?? []) as Record<string, unknown>[])
          .filter((m) => m.left_at == null)
          .map((m) => str(m.network_id)),
        listing,
      };
    },
    `${ctx.orgId}|${storeId ?? ''}`,
  );

  if (data.status === 'loading')
    return (
      <div className="admin-page">
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      </div>
    );
  if (data.status === 'error' || !data.data)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
      </div>
    );
  const { nets, joined } = data.data;
  const member = nets.filter((n) => joined.includes(n.id));
  const net = member[0] ?? null;
  const l = draft ?? data.data.listing ?? EMPTY;
  const origin = globalThis.location?.origin ?? '';

  const flip = async (n: Net, join: boolean) => {
    setError(null);
    const r = await ctx.client.rpc('join_network', {
      p_org: ctx.orgId,
      p_slug: n.slug,
      p_join: join,
    });
    if (r.error) return setError(r.error.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    data.reload();
  };
  const saveListing = async () => {
    setError(null);
    setNote(null);
    if (!storeId || l.titleTh.trim() === '') return setNote('bad');
    const about = {
      ...(l.aboutTh.trim() ? { th: l.aboutTh.trim() } : {}),
      ...(l.aboutEn.trim() ? { en: l.aboutEn.trim() } : {}),
    };
    const r = await ctx.client.rpc('save_network_listing', {
      p: {
        store_id: storeId,
        category: l.category,
        title: { th: l.titleTh.trim(), ...(l.titleEn.trim() ? { en: l.titleEn.trim() } : {}) },
        about: Object.keys(about).length ? about : null,
        visible: l.visible,
      },
    });
    if (r.error) return setNote('failed');
    setNote('saved');
    data.reload();
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote('copied');
    } catch {
      setNote(null);
    }
  };
  const issue = async () => {
    setError(null);
    setIssued(null);
    if (!storeId || name.trim() === '' || phone.replace(/\D/g, '').length < 8)
      return setNote('bad');
    setNote(null);
    const r = await ctx.client.rpc('staff_issue_pass', {
      p: { store_id: storeId, name: name.trim(), phone: phone.trim() },
    });
    if (r.error) return setNote(r.error.code === '22023' ? 'bad' : 'failed');
    const o = (r.data ?? {}) as Record<string, unknown>;
    setIssued({ token: str(o.token), code: str(o.code), name: str(o.name) });
  };
  const loadClearing = async () => {
    setError(null);
    const r = await ctx.client.rpc('network_clearing', {
      p_org: ctx.orgId,
      p_from: from,
      p_to: to,
    });
    if (r.error) return setError(r.error.code === '42501' ? 'err_forbidden' : 'err_load_failed');
    setRows(
      ((r.data ?? []) as Record<string, unknown>[]).map((x) => ({
        issuer: str(x.issuer_name),
        redeemer: str(x.redeemer_name),
        points: Number(x.points) || 0,
        amount: Number(x.amount) || 0,
        issuerOrg: str(x.issuer_org),
        redeemerOrg: str(x.redeemer_org),
      })),
    );
  };
  const totals = rows ? clearingTotals(rows, ctx.orgId) : null;

  return (
    <div className="admin-page">
      <h1>{t.nwTitle}</h1>
      <Notice kind="info">{t.nwIntro}</Notice>
      <Notice kind="info">{t.nwLegal}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}

      <section className="card admin-card" aria-label={t.nwMembership}>
        <h2>{t.nwMembership}</h2>
        {nets.length === 0 ? <p className="muted">{t.nwNoNetworks}</p> : null}
        <ul className="plain-list">
          {nets.map((n) => {
            const isIn = joined.includes(n.id);
            return (
              <li key={n.id} className="actions">
                <strong>{n.nameEn || n.nameTh}</strong>
                <span className="muted">{isIn ? t.nwJoined : ''}</span>
                {ctx.isOwner ? (
                  <AsyncButton variant="secondary" onClick={() => flip(n, !isIn)}>
                    {isIn ? t.nwLeave : t.nwJoin}
                  </AsyncButton>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!ctx.isOwner ? <p className="muted">{t.nwOwnerOnly}</p> : null}
      </section>

      {!net ? (
        <Notice kind="info">{t.nwNeedJoin}</Notice>
      ) : (
        <>
          {canEdit && storeId ? (
            <section className="card admin-card" aria-label={t.nwListing}>
              <h2>{t.nwListing}</h2>
              <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
                <div className="form-row">
                  <label className="label" htmlFor="nw-cat">
                    {t.nwCategory}
                  </label>
                  <select
                    id="nw-cat"
                    className="field"
                    value={l.category}
                    onChange={(e) =>
                      setDraft({ ...l, category: e.target.value as NetworkCategory })
                    }
                  >
                    {NETWORK_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {t[CAT_KEY[c]]}
                      </option>
                    ))}
                  </select>
                </div>
                {(
                  [
                    ['nw-th', t.nwTitleTh, 'titleTh', 80],
                    ['nw-en', t.nwTitleEn, 'titleEn', 80],
                    ['nw-ath', t.nwAboutTh, 'aboutTh', 300],
                    ['nw-aen', t.nwAboutEn, 'aboutEn', 300],
                  ] as const
                ).map(([id, label, key, max]) => (
                  <div className="form-row" key={id}>
                    <label className="label" htmlFor={id}>
                      {label}
                    </label>
                    <input
                      id={id}
                      className="field"
                      maxLength={max}
                      value={l[key]}
                      onChange={(e) => setDraft({ ...l, [key]: e.target.value })}
                    />
                  </div>
                ))}
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={l.visible}
                    onChange={(e) => setDraft({ ...l, visible: e.target.checked })}
                  />
                  <span>{t.nwVisible}</span>
                </label>
                {note === 'saved' ? <Notice kind="success">{t.nwSaved}</Notice> : null}
                {note === 'failed' ? <Notice kind="error">{t.nwSaveFailed}</Notice> : null}
                <div className="actions">
                  <AsyncButton type="submit" onClick={saveListing}>
                    {t.nwSave}
                  </AsyncButton>
                </div>
              </form>
            </section>
          ) : null}

          <section className="card admin-card" aria-label={t.nwLinks}>
            <h2>{t.nwLinks}</h2>
            {(
              [
                [t.nwJoinLink, joinLink(origin, net.slug), t.nwQrJoin],
                [t.nwIslandLink, islandLink(origin, net.slug), t.nwQrIsland],
              ] as const
            ).map(([label, link, qr]) => (
              <div className="form-row" key={link}>
                <label className="label" htmlFor={`nw-link-${net.slug}-${label}`}>
                  {label}
                </label>
                <input
                  id={`nw-link-${net.slug}-${label}`}
                  className="field"
                  readOnly
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="qr-print">
                  <QrSvg value={link} label={qr} />
                </div>
                <AsyncButton variant="secondary" onClick={() => copy(link)}>
                  {t.nwCopy}
                </AsyncButton>
              </div>
            ))}
            {note === 'copied' ? <Notice kind="success">{t.nwCopied}</Notice> : null}
          </section>

          {canIssue && storeId ? (
            <section className="card admin-card" aria-label={t.nwIssue}>
              <h2>{t.nwIssue}</h2>
              <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
                <div className="form-row">
                  <label className="label" htmlFor="nw-iname">
                    {t.nwIssueName}
                  </label>
                  <input
                    id="nw-iname"
                    className="field"
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="form-row">
                  <label className="label" htmlFor="nw-iphone">
                    {t.nwIssuePhone}
                  </label>
                  <input
                    id="nw-iphone"
                    className="field"
                    type="tel"
                    inputMode="tel"
                    maxLength={30}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                {note === 'bad' ? <Notice kind="error">{t.nwIssueBad}</Notice> : null}
                <div className="actions">
                  <AsyncButton type="submit" onClick={issue}>
                    {t.nwIssueGo}
                  </AsyncButton>
                </div>
              </form>
              {issued ? (
                <div role="status">
                  <Notice kind="success">{t.nwIssued}</Notice>
                  <p>
                    {t.nwIssuedCode}: <strong className="mono">{issued.code}</strong>
                  </p>
                  <div className="qr-print">
                    <QrSvg value={passLink(origin, issued.token)} label={t.npQrAlt} />
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {canReport ? (
            <section className="card admin-card" aria-label={t.nwClearing}>
              <h2>{t.nwClearing}</h2>
              <p className="muted">{t.nwClearingIntro}</p>
              <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
                <div className="form-row">
                  <label className="label" htmlFor="nw-from">
                    {t.nwFrom}
                  </label>
                  <input
                    id="nw-from"
                    className="field"
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div className="form-row">
                  <label className="label" htmlFor="nw-to">
                    {t.nwTo}
                  </label>
                  <input
                    id="nw-to"
                    className="field"
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
                <div className="actions">
                  <AsyncButton type="submit" onClick={loadClearing}>
                    {t.nwShow}
                  </AsyncButton>
                </div>
              </form>
              {rows && rows.length === 0 ? <p className="muted">{t.nwClearingNone}</p> : null}
              {rows && rows.length > 0 && totals ? (
                <>
                  <table className="clearing-table">
                    <thead>
                      <tr>
                        <th>{t.nwColIssuer}</th>
                        <th>{t.nwColRedeemer}</th>
                        <th>{t.nwColPoints}</th>
                        <th>{t.nwColAmount}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={`${r.issuerOrg}-${r.redeemerOrg}`}>
                          <td>{r.issuer}</td>
                          <td>{r.redeemer}</td>
                          <td>{r.points}</td>
                          <td>{formatTHB(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p>
                    {t.nwOwedToMe}: <strong>{formatTHB(totals.owedToMe)}</strong>
                  </p>
                  <p>
                    {t.nwIWe}: <strong>{formatTHB(totals.iOwe)}</strong>
                  </p>
                  <Notice kind="info">{t.nwClearingNote}</Notice>
                </>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
