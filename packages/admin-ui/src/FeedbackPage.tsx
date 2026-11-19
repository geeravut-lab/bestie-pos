import { useState } from 'react';
import { feedbackSummary, parseFeedback } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/** What guests said from the table page: newest first, low ratings first to follow up. Needs report.view. */
export function FeedbackPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const canSee = ctx.isOwner || ctx.permissions.includes('report.view');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const list = useRemote(
    async () => {
      if (!storeId) return [];
      const { data, error: e } = await ctx.client
        .from('guest_feedback')
        .select('id, rating, topic, comment, handled, created_at, dining_tables(name)')
        .eq('store_id', storeId)
        .order('created_at', { ascending: false });
      if (e) throw new Error(e.code ?? 'query');
      return parseFeedback(data);
    },
    `${storeId ?? ''}`,
  );

  if (!canSee)
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_forbidden', t)}</Notice>
      </div>
    );
  const rows = list.data ?? [];
  const sum = feedbackSummary(rows);
  const shown = onlyOpen ? rows.filter((r) => !r.handled) : rows;
  const mark = async (id: string, handled: boolean) => {
    setError(null);
    const { error: e } = await ctx.client.rpc('handle_feedback', { p_id: id, p_handled: handled });
    if (e) return setError(e.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    list.reload();
  };
  const when = (iso: string) =>
    new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
      timeZone: 'Asia/Bangkok',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));

  return (
    <div className="admin-page">
      <h1>{t.feedbackTitle}</h1>
      <Notice kind="info">{t.feedbackIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {list.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {list.status === 'ready' && rows.length === 0 ? (
        <p className="muted">{t.feedbackNone}</p>
      ) : null}
      {rows.length > 0 ? (
        <>
          <p className="tabular">
            {fmt(t.feedbackSummary, { count: sum.count, avg: sum.average ?? '-', open: sum.open })}
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={onlyOpen}
              onChange={(e) => setOnlyOpen(e.target.checked)}
            />
            <span>{t.feedbackOnlyOpen}</span>
          </label>
        </>
      ) : null}
      <ul className="member-list">
        {shown.map((r) => (
          <li key={r.id} className="member-row">
            <strong aria-label={`${r.rating} / 5`}>{'★'.repeat(r.rating)}</strong>{' '}
            <span className="muted">
              {tx(t, `gsFbTopic_${r.topic}`)}
              {r.tableName ? ` · ${fmt(t.feedbackTable, { name: r.tableName })}` : ''} ·{' '}
              {when(r.createdAt)}
            </span>
            {r.comment ? <p style={{ whiteSpace: 'pre-wrap' }}>{r.comment}</p> : null}
            <div className="actions">
              {r.handled ? <span className="badge">{t.feedbackHandled}</span> : null}
              <AsyncButton variant="secondary" onClick={() => mark(r.id, !r.handled)}>
                {r.handled ? t.feedbackUnhandle : t.feedbackHandle}
              </AsyncButton>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
