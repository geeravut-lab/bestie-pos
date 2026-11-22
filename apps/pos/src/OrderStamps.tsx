import { useState } from 'react';
import { formatTHB, guestName, parseStampStatus, stampsToNext } from '@bestie/core';
import type { PageContext } from '@bestie/auth';
import { Notice } from '@bestie/auth';
import { fmt, useI18n } from '@bestie/i18n';
import { getDeviceBinding } from '@bestie/offline';
import { AsyncButton } from '@bestie/ui';
import { useRemote } from '@bestie/admin-ui';

/**
 * The member's stamp cards and day passes on the order screen (module `stamps`, online only): shows how close she is, and a reward
 * or today's pass makes ONE unsent line of the free item cost nothing. The server decides everything; this only asks.
 */
export function OrderStamps({
  ctx,
  orderId,
  storeId,
  online,
}: {
  ctx: PageContext;
  orderId: string;
  storeId: string;
  online: boolean;
}) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const [note, setNote] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const data = useRemote(async () => {
    if (!online) return null;
    const o = await ctx.client.from('orders').select('customer_id').eq('id', orderId).maybeSingle();
    const customer = (o.data as { customer_id: string | null } | null)?.customer_id ?? null;
    if (!customer) return { customer: null, programs: [] };
    const r = await ctx.client.rpc('stamp_status', {
      p: { store_id: storeId, customer_id: customer },
    });
    if (r.error) throw new Error('stamps');
    return { customer, programs: parseStampStatus(r.data) };
  }, `${orderId}:${storeId}:${online}`);
  const { reload } = data;
  if (!online || !data.data) return null;
  const { customer, programs } = data.data;
  if (programs.length === 0 && customer) return null;
  if (!customer) return <p className="muted">{t.stoNeedMember}</p>;

  const use = async (programId: string) => {
    setNote(null);
    const r = await ctx.client.rpc('redeem_stamp_reward', {
      p: { order_id: orderId, program_id: programId },
    });
    if (r.error)
      return setNote({
        kind: 'error',
        text: r.error.code === '55000' ? t.stoNeedItem : t.stoErr,
      });
    setNote({ kind: 'success', text: t.stoUsed });
    reload();
  };
  const sell = async (programId: string) => {
    setNote(null);
    const r = await ctx.client.rpc('sell_stamp_pass', {
      p: {
        store_id: storeId,
        program_id: programId,
        customer_id: customer,
        device_id: getDeviceBinding()?.deviceId ?? null,
      },
    });
    if (r.error || typeof r.data !== 'string') return setNote({ kind: 'error', text: t.stoErr });
    ctx.navigate(`/order/${r.data}`);
  };

  return (
    <section className="card admin-card" aria-label={t.stoTitle}>
      <h2>{t.stoTitle}</h2>
      {note ? <Notice kind={note.kind}>{note.text}</Notice> : null}
      <ul className="member-list">
        {programs.map((p) => (
          <li key={p.programId}>
            <strong>{guestName(p.name, lang)}</strong>{' '}
            {p.kind === 'stamps' ? (
              <>
                <span className="muted">
                  {fmt(t.stoStamps, { n: p.stamps, m: stampsToNext(p) ?? 0 })}
                </span>
                {p.rewardsReady > 0 ? (
                  <>
                    {' '}
                    <span className="badge">{fmt(t.stoReady, { n: p.rewardsReady })}</span>
                    <AsyncButton onClick={() => use(p.programId)}>{t.stoUse}</AsyncButton>
                  </>
                ) : null}
              </>
            ) : p.passUntil ? (
              <>
                <span className="muted">{fmt(t.stoPassUntil, { date: p.passUntil })}</span>{' '}
                {p.passUsedToday ? (
                  <span className="badge">{t.stoPassUsed}</span>
                ) : (
                  <AsyncButton onClick={() => use(p.programId)}>{t.stoPassUse}</AsyncButton>
                )}
              </>
            ) : (
              <AsyncButton variant="secondary" onClick={() => sell(p.programId)}>
                {fmt(t.stoSellPass, { price: money(p.passPrice ?? 0) })}
              </AsyncButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
