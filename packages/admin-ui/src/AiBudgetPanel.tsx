import { useState } from 'react';
import { formatTHB, parsePriceInput } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

/** The monthly AI budget of the business (owner / platform administrator): when this month's estimated cost reaches it, guest and staff AI answers pause until next month. */
export function AiBudgetPanel({ ctx, orgId }: { ctx: PageContext; orgId: string }) {
  const { t, lang } = useI18n();
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const can = ctx.isOwner || ctx.isPlatformAdmin;
  const cap = useRemote(async () => {
    const r = await ctx.client
      .from('ai_budgets')
      .select('monthly_cap')
      .eq('org_id', orgId)
      .maybeSingle();
    return r.error ? null : ((r.data as { monthly_cap: number } | null)?.monthly_cap ?? null);
  }, orgId);
  const { reload } = cap;
  if (!can) return null;
  const set = async (satang: number | null) => {
    setMsg(null);
    const r = await ctx.client.rpc('set_ai_budget', { p_org: orgId, p_cap: satang });
    if (r.error) return setMsg({ kind: 'error', text: t.abErr });
    setMsg({ kind: 'success', text: t.abSaved });
    setValue('');
    reload();
  };
  const save = async () => {
    const v = parsePriceInput(value);
    if (v === null) return setMsg({ kind: 'error', text: t.abInvalid });
    await set(v);
  };
  return (
    <section className="card admin-card" aria-label={t.abTitle}>
      <h2>{t.abTitle}</h2>
      <p className="muted">{t.abIntro}</p>
      <p>
        {t.abCurrent}:{' '}
        <strong>
          {cap.data === null || cap.data === undefined
            ? t.abNone
            : formatTHB(cap.data, lang === 'th' ? 'th-TH' : 'en-GB')}
        </strong>
      </p>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <div className="form-inline">
        <div className="form-row">
          <label className="label" htmlFor="ab-cap">
            {t.abLabel}
          </label>
          <input
            id="ab-cap"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <AsyncButton onClick={save}>{t.abSave}</AsyncButton>
        <AsyncButton variant="secondary" onClick={() => set(null)}>
          {t.abRemove}
        </AsyncButton>
      </div>
    </section>
  );
}
