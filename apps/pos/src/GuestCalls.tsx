import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

type Call = { id: string; reason: 'help' | 'bill'; created_at: string; table: string };

/**
 * Guests who pressed "call staff" on their table page: open calls on the floor plan, newest first, with "Got it". Refreshes by itself
 * (the shop's live channel) and every 20 s as a fallback. Needs a network (a guest call itself only exists online).
 */
export function GuestCalls({ ctx, storeId }: { ctx: PageContext; storeId: string }) {
  const { t } = useI18n();
  const [calls, setCalls] = useState<Call[]>([]);
  const load = useCallback(async () => {
    try {
      const r = await ctx.client
        .from('guest_calls')
        .select('id, reason, created_at, dining_tables(name)')
        .eq('store_id', storeId)
        .eq('status', 'open')
        .order('created_at', { ascending: false });
      if (r.error) return;
      setCalls(
        (
          (r.data ?? []) as unknown as {
            id: string;
            reason: string;
            created_at: string;
            dining_tables: { name?: string } | { name?: string }[] | null;
          }[]
        ).map((c) => ({
          id: c.id,
          reason: c.reason === 'bill' ? 'bill' : 'help',
          created_at: c.created_at,
          table: String(
            (Array.isArray(c.dining_tables) ? c.dining_tables[0] : c.dining_tables)?.name ?? '',
          ),
        })),
      );
    } catch {
      /* offline: a guest call only exists online anyway; try again on the next tick */
    }
  }, [ctx.client, storeId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async read of an EXTERNAL system (the database); state is set after the await
    void load();
    const i = setInterval(() => void load(), 20_000);
    return () => clearInterval(i);
  }, [load]);
  useLiveSync(ctx.client, [`store:${storeId}`], load);

  if (calls.length === 0) return null;
  return (
    <section className="card admin-card guest-calls" aria-label={t.callsTitle} role="status">
      <h2>{t.callsTitle}</h2>
      <ul className="member-list">
        {calls.map((c) => (
          <li key={c.id} className="member-row">
            <div className="member-head">
              <strong>
                {c.reason === 'bill' ? t.callsBill : t.callsHelp} · {t.callsTable} {c.table}
              </strong>
              <AsyncButton
                variant="secondary"
                onClick={async () => {
                  const { error } = await ctx.client.rpc('answer_guest_call', { p_id: c.id });
                  if (error) throw error;
                  await load();
                }}
              >
                {t.callsGotIt}
              </AsyncButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
