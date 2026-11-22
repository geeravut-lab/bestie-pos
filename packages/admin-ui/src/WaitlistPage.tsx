import { useState } from 'react';
import { bangkokDate, formatTHB, parseTurnover, parseWaitlist, waitedMinutes } from '@bestie/core';
import type { WaitEntry } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const addDays = (d: string, n: number): string => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** The waiting list of a busy restaurant: add a party with a quoted wait (from how long tables are really used), call, seat, and how the tables turn over. */
export function WaitlistPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canReport = ctx.isOwner || ctx.permissions.includes('report.view');
  const [form, setForm] = useState({ name: '', phone: '', party: '2' });
  const [seat, setSeat] = useState<{ id: string; table: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const to = bangkokDate(Date.now());
    const [rows, tables, turn] = await Promise.all([
      ctx.client
        .from('waitlist_entries')
        .select('*')
        .eq('store_id', storeId)
        .in('status', ['waiting', 'called'])
        .order('created_at'),
      ctx.client
        .from('dining_tables')
        .select('id, name, seats')
        .eq('store_id', storeId)
        .eq('active', true)
        .is('deleted_at', null)
        .order('sort'),
      canReport
        ? ctx.client.rpc('table_turnover', { p: { store_id: storeId, from: addDays(to, -29), to } })
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (rows.error) throw new Error('load');
    setNow(Date.now());
    return {
      entries: parseWaitlist(rows.data),
      tables: (tables.data ?? []) as { id: string; name: string; seats: number }[],
      turnover: turn.error || !turn.data ? [] : parseTurnover(turn.data),
    };
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;

  const fail = (code?: string) =>
    setMsg({
      kind: 'error',
      text: code === '0A000' ? t.wlOff : code === '42501' ? t.err_forbidden : t.wlInvalid,
    });
  const add = async () => {
    setMsg(null);
    const party = Number(form.party);
    if (!storeId || !form.name.trim() || !Number.isInteger(party) || party < 1 || party > 50)
      return setMsg({ kind: 'error', text: t.wlInvalid });
    const r = await ctx.client.rpc('waitlist_add', {
      p: {
        store_id: storeId,
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        party,
        client_id: globalThis.crypto.randomUUID(),
      },
    });
    if (r.error) return fail(r.error.code);
    const o = (r.data ?? {}) as { quoted_min?: number };
    setForm({ name: '', phone: '', party: '2' });
    setMsg({ kind: 'success', text: fmt(t.wlAdded, { min: o.quoted_min ?? 0 }) });
    reload();
  };
  const move = async (e: WaitEntry, status: 'called' | 'seated' | 'left', table?: string) => {
    const r = await ctx.client.rpc('waitlist_set', {
      p_id: e.id,
      p_status: status,
      p_table: table ?? null,
    });
    if (r.error) return fail(r.error.code);
    setSeat(null);
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.wlTitle}</h1>
      <Notice kind="info">{t.wlIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      <section className="card admin-card" aria-label={t.wlAdd}>
        <h2>{t.wlAdd}</h2>
        <div className="form-inline">
          <div className="form-row">
            <label className="label" htmlFor="wl-name">
              {t.wlName}
            </label>
            <input
              id="wl-name"
              value={form.name}
              maxLength={60}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="wl-phone">
              {t.wlPhone}
            </label>
            <input
              id="wl-phone"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="wl-party">
              {t.wlParty}
            </label>
            <input
              id="wl-party"
              inputMode="numeric"
              value={form.party}
              onChange={(e) => setForm({ ...form, party: e.target.value })}
            />
          </div>
          <AsyncButton onClick={add}>{t.wlAddBtn}</AsyncButton>
        </div>
      </section>

      <section className="card admin-card" aria-label={t.wlWaiting}>
        <h2>{t.wlWaiting}</h2>
        {d && d.entries.length === 0 ? <p className="muted">{t.wlNone}</p> : null}
        <ul className="member-list">
          {(d?.entries ?? []).map((e) => (
            <li key={e.id}>
              <strong>{e.name}</strong> · {fmt(t.wlPartyOf, { n: e.party })}{' '}
              {e.status === 'called' ? <span className="badge">{t.wlCalled}</span> : null}
              <span className="muted">
                {' '}
                · {fmt(t.wlWaited, { min: waitedMinutes(e.createdAt, now), quote: e.quotedMin })}
              </span>
              {e.phone ? <span className="muted"> · {e.phone}</span> : null}
              <div className="actions">
                {e.status === 'waiting' ? (
                  <AsyncButton variant="secondary" onClick={() => move(e, 'called')}>
                    {t.wlCall}
                  </AsyncButton>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setSeat({ id: e.id, table: d?.tables[0]?.id ?? '' })}
                >
                  {t.wlSeat}
                </button>
                <AsyncButton variant="secondary" onClick={() => move(e, 'left')}>
                  {t.wlLeft}
                </AsyncButton>
              </div>
              {seat?.id === e.id ? (
                <div className="form-inline">
                  <label className="label" htmlFor={`wl-t-${e.id}`}>
                    {t.wlTable}
                  </label>
                  <select
                    id={`wl-t-${e.id}`}
                    value={seat.table}
                    onChange={(ev) => setSeat({ id: e.id, table: ev.target.value })}
                  >
                    {(d?.tables ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({x.seats})
                      </option>
                    ))}
                  </select>
                  <AsyncButton onClick={() => move(e, 'seated', seat.table || undefined)}>
                    {t.wlSeatConfirm}
                  </AsyncButton>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {canReport ? (
        <section className="card admin-card" aria-label={t.wlTurnover}>
          <h2>{t.wlTurnover}</h2>
          <p className="muted">{t.wlTurnoverNote}</p>
          {d && d.turnover.length === 0 ? <p className="muted">{t.wlTurnoverNone}</p> : null}
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {(d?.turnover ?? []).map((r) => (
                  <tr key={r.tableId}>
                    <td>
                      {r.name} ({r.seats})
                    </td>
                    <td className="tabular">{fmt(t.wlBills, { n: r.bills })}</td>
                    <td className="tabular">{fmt(t.touMin, { n: r.avgMin })}</td>
                    <td className="tabular">{money(r.revenue)}</td>
                    <td className="tabular">{fmt(t.wlPerHour, { amount: money(r.perHour) })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
