import { useState } from 'react';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

/** The seller's address printed on a full tax invoice: the company's and this branch's (owner only). */
export function TaxProfilePanel({ ctx, storeId }: { ctx: PageContext; storeId: string }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ company: string; branch: string } | null>(null);
  const [note, setNote] = useState<'saved' | 'failed' | null>(null);
  const data = useRemote(async () => {
    const r = await ctx.client
      .from('stores')
      .select('address, legal_entities(address)')
      .eq('id', storeId)
      .maybeSingle();
    const d = r.data as {
      address?: string | null;
      legal_entities?: { address?: string | null } | null;
    } | null;
    return { company: d?.legal_entities?.address ?? '', branch: d?.address ?? '' };
  }, storeId);
  if (!ctx.isOwner) return null;
  const v = draft ?? data.data ?? { company: '', branch: '' };
  const save = async () => {
    setNote(null);
    const { error } = await ctx.client.rpc('save_tax_profile', {
      p: { store_id: storeId, company_address: v.company, branch_address: v.branch },
    });
    setNote(error ? 'failed' : 'saved');
  };
  return (
    <section className="card admin-card" aria-label={t.tpTitle}>
      <h2>{t.tpTitle}</h2>
      <p className="muted">{t.tpIntro}</p>
      <div className="form-row">
        <label className="label" htmlFor="tp-company">
          {t.tpCompany}
        </label>
        <textarea
          id="tp-company"
          className="field"
          rows={2}
          maxLength={300}
          value={v.company}
          onChange={(e) => setDraft({ ...v, company: e.target.value })}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="tp-branch">
          {t.tpBranch}
        </label>
        <textarea
          id="tp-branch"
          className="field"
          rows={2}
          maxLength={300}
          value={v.branch}
          onChange={(e) => setDraft({ ...v, branch: e.target.value })}
        />
      </div>
      {note === 'saved' ? <Notice kind="success">{t.tpSaved}</Notice> : null}
      {note === 'failed' ? <Notice kind="error">{t.err_save_failed}</Notice> : null}
      <div className="actions">
        <AsyncButton onClick={save}>{t.tpSave}</AsyncButton>
      </div>
    </section>
  );
}
