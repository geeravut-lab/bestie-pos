import { useState } from 'react';
import { useRemote } from './useRemote';
import { ASK_PRESETS } from '@bestie/core';
import type { AskPreset } from '@bestie/core';
import { AppError, errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { askShop } from './aiApi';
import type { ShopAnswer } from './aiApi';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;
const PRESET_KEY: Record<AskPreset, string> = {
  today: 'repPresetToday',
  yesterday: 'repPresetYesterday',
  last7: 'repPresetLast7',
  last30: 'repPresetLast30',
  month: 'repPresetMonth',
};
const EXAMPLES = ['askShopEx1', 'askShopEx2', 'askShopEx3', 'askShopEx4'] as const;

/** "Ask my shop" (owner / manager): a plain-language answer about a period. Read only; every figure is read from the shop's reports. */
export function AskShopPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canAsk = ctx.isOwner || ctx.permissions.includes('report.view');
  const on = ctx.isModuleOn?.('ai.assistant') ?? true;
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const [scope, setScope] = useState(''); // '' = the signed-in shop, 'all' = every shop together, else a shop id
  const shops = useRemote(async () => {
    const { data, error } = await ctx.client
      .from('stores')
      .select('id, name')
      .eq('org_id', ctx.orgId)
      .is('deleted_at', null)
      .order('created_at');
    if (error) throw new Error(error.code ?? 'query');
    return (data ?? []) as { id: string; name: string }[];
  }, ctx.orgId);
  const [preset, setPreset] = useState<AskPreset>('last7');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<ShopAnswer | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  if (!canAsk)
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_forbidden', t)}</Notice>
      </div>
    );

  const ask = async () => {
    setError(null);
    setResult(null);
    const target = scope === 'all' ? { orgId: ctx.orgId } : { storeId: scope || storeId };
    if (!('orgId' in target) && !target.storeId) return setError('err_load_failed');
    try {
      setResult(await askShop(ctx.client, target as { storeId: string }, preset, question.trim()));
    } catch (e) {
      setError(e instanceof AppError ? e.code : 'err_unknown');
    }
  };

  return (
    <div className="admin-page">
      <h1>{t.askShopTitle}</h1>
      <Notice kind="info">{t.askShopIntro}</Notice>
      {!on ? <Notice kind="info">{t.askShopOff}</Notice> : null}
      <section className="card admin-card auth-form">
        {(shops.data?.length ?? 0) > 1 ? (
          <div className="form-row">
            <label className="label" htmlFor="ask-shop">
              {t.repShop}
            </label>
            <select
              id="ask-shop"
              className="field"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">{t.askShopThisShop}</option>
              <option value="all">{t.repAllShops}</option>
              {(shops.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="form-row">
          <label className="label" htmlFor="ask-period">
            {t.askShopPeriod}
          </label>
          <select
            id="ask-period"
            className="field"
            value={preset}
            onChange={(e) => setPreset(e.target.value as AskPreset)}
          >
            {ASK_PRESETS.map((p) => (
              <option key={p} value={p}>
                {tx(t, PRESET_KEY[p])}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="label" htmlFor="ask-q">
            {t.askShopQuestion}
          </label>
          <textarea
            id="ask-q"
            className="field"
            rows={3}
            maxLength={300}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </div>
        <div className="chips" role="group" aria-label={t.askShopExamples}>
          {EXAMPLES.map((k) => (
            <button key={k} type="button" className="chip" onClick={() => setQuestion(tx(t, k))}>
              {tx(t, k)}
            </button>
          ))}
        </div>
        <div className="actions">
          <AsyncButton disabled={!on || question.trim().length < 2} onClick={ask}>
            {t.askShopSend}
          </AsyncButton>
        </div>
      </section>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {result && !result.available ? <Notice kind="info">{t.askShopUnavailable}</Notice> : null}
      {result && result.available ? (
        <section className="card admin-card" aria-live="polite">
          <h2>{t.askShopAnswer}</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</p>
          {result.unverified.length > 0 ? (
            <Notice kind="error">
              {fmt(t.askShopUnverified, { list: result.unverified.join(', ') })}
            </Notice>
          ) : (
            <p className="muted">{t.askShopVerified}</p>
          )}
          <details>
            <summary>{t.askShopFigures}</summary>
            <pre className="muted" style={{ whiteSpace: 'pre-wrap' }}>
              {result.figures}
            </pre>
          </details>
        </section>
      ) : null}
    </div>
  );
}
