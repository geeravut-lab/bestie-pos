import { useState } from 'react';
import { formatTHB, guestName, parseInsights } from '@bestie/core';
import type { Insight, LocalizedText } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Brief = { available: boolean; summary: string | null; unverified: string[] };
const asObj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/** The business manager: what the system found in the shop's records this morning, with the figures as evidence; the owner approves or dismisses (needs `report.view` + the module). */
export function BriefPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (satang: number) => formatTHB(satang, locale);
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [off, setOff] = useState(false);

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const r = await ctx.client.rpc('brief_context', { p_store: storeId });
    if (r.error) {
      setOff(true);
      return [] as Insight[];
    }
    setOff(false);
    return parseInsights(r.data);
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const list = data.data ?? [];
  const names: Record<string, string> = {
    low_stock: t.bmK_low_stock,
    thin_margin: t.bmK_thin_margin,
    sales_drop: t.bmK_sales_drop,
    waste_high: t.bmK_waste_high,
    expiring: t.bmK_expiring,
    cases_overdue: t.bmK_cases_overdue,
    cost_rise: t.bmK_cost_rise,
  };
  const sev: Record<string, string> = {
    act: t.bmSev_act,
    watch: t.bmSev_watch,
    info: t.bmSev_info,
  };

  const explain = async () => {
    setNote(null);
    const { data: s } = await ctx.client.auth.getSession();
    const token = s.session?.access_token;
    if (!token || !storeId) return setNote(t.err_forbidden);
    const res = await fetch('/api/brief/summary', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId }),
    });
    if (res.status === 403) return setNote(t.err_forbidden);
    if (!res.ok) return setNote(t.err_unknown);
    setBrief((await res.json()) as Brief);
  };
  const decide = async (i: Insight, decision: 'approved' | 'dismissed') => {
    setNote(null);
    const r = await ctx.client.rpc('decide_insight', { p_id: i.id, p_decision: decision });
    if (r.error) return setNote(r.error.code === '42501' ? t.err_forbidden : t.err_save_failed);
    const made = (asObj(r.data).purchase_orders as unknown[] | undefined)?.length ?? 0;
    if (made > 0) setNote(fmt(t.bmDrafted, { n: made }));
    reload();
  };
  const detail = (i: Insight): string[] => {
    const e = i.evidence;
    const arr = (x: unknown) => (Array.isArray(x) ? x.map(asObj) : []);
    const nm = (x: unknown) => guestName(asObj(x) as LocalizedText, lang);
    switch (i.kind) {
      case 'low_stock':
        return arr(e.items).map((it) =>
          fmt(t.bmLow, {
            name: nm(it.name),
            qty: `${n(it.quantity)} ${String(it.unit ?? '')}`,
            days: n(it.days_left),
            sug: n(it.suggested),
          }),
        );
      case 'thin_margin':
        return arr(e.items).map((it) =>
          fmt(t.bmThin, {
            name: nm(it.name),
            price: money(n(it.price)),
            cost: money(n(it.cost)),
            pct: Math.round(n(it.margin_bps) / 100),
          }),
        );
      case 'sales_drop':
        return [fmt(t.bmDrop, { yesterday: money(n(e.yesterday)), usual: money(n(e.usual)) })];
      case 'waste_high':
        return [fmt(t.bmWaste, { waste: money(n(e.waste)), sales: money(n(e.sales)) })];
      case 'expiring':
        return arr(e.lots).map((it) =>
          fmt(t.bmLot, { item: nm(it.item), qty: n(it.qty), date: String(it.expires_on ?? '') }),
        );
      case 'cases_overdue':
        return [fmt(t.bmCases, { n: n(e.cases) })];
      default:
        return [];
    }
  };
  const fresh = list.filter((i) => i.status === 'new');
  const decided = list.filter((i) => i.status !== 'new').slice(0, 8);
  return (
    <div className="admin-page">
      <h1>{t.bmTitle}</h1>
      <Notice kind="info">{t.bmIntro}</Notice>
      {off ? <Notice kind="error">{t.bmOff}</Notice> : null}
      {note ? <Notice kind="info">{note}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {!off && fresh.length > 0 ? (
        <div className="actions">
          <AsyncButton variant="secondary" onClick={explain}>
            {t.bmExplain}
          </AsyncButton>
        </div>
      ) : null}
      {brief && brief.available === false ? <Notice kind="info">{t.bmNoKey}</Notice> : null}
      {brief?.summary ? (
        <section className="card admin-card" aria-label={t.bmTitle}>
          <p>{brief.summary}</p>
          {brief.unverified.length > 0 ? (
            <Notice kind="error">{fmt(t.bmUnverified, { n: brief.unverified.join(', ') })}</Notice>
          ) : null}
        </section>
      ) : null}
      {!off && data.status === 'ready' && fresh.length === 0 ? (
        <p className="muted">{t.bmNone}</p>
      ) : null}
      <ul className="member-list">
        {fresh.map((i) => (
          <li key={i.id} className="card admin-card">
            <h2>
              {names[i.kind]} <span className={`badge sev-${i.severity}`}>{sev[i.severity]}</span>
            </h2>
            <ul>
              {detail(i).map((line, k) => (
                <li key={k}>{line}</li>
              ))}
            </ul>
            <div className="actions">
              <AsyncButton onClick={() => decide(i, 'approved')}>
                {i.action?.type === 'draft_po' ? t.bmApproveDraft : t.bmApprove}
              </AsyncButton>
              <AsyncButton variant="secondary" onClick={() => decide(i, 'dismissed')}>
                {t.bmDismiss}
              </AsyncButton>
            </div>
          </li>
        ))}
      </ul>
      {decided.length > 0 ? (
        <ul className="muted">
          {decided.map((i) => (
            <li key={i.id}>
              {names[i.kind]} · {t.bmDone}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
