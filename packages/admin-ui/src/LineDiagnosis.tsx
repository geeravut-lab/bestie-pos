import { useState } from 'react';
import { fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

export type DiagCheck = {
  id: string;
  level: 'ok' | 'fail' | 'warn' | 'info';
  data?: Record<string, string | number | boolean>;
};
type Result = { checks: DiagCheck[]; expectedWebhook: string };

const ICON = { ok: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️' } as const;

/** One check → one plain sentence (the server sends only ids, levels and short facts, never provider text). */
export function diagText(t: Dict, c: DiagCheck): string {
  const d = (t as Record<string, string>) ?? {};
  const reason = typeof c.data?.reason === 'string' ? `_${c.data.reason}` : '';
  const tpl =
    d[`lineDiag_${c.id}_${c.level}${reason}`] ??
    d[`lineDiag_${c.id}_${c.level}`] ??
    d.lineDiag_unknown ??
    '';
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(c.data ?? {}))
    vars[k] = typeof v === 'boolean' ? String(v) : v;
  return fmt(tpl, vars);
}

/** Platform admin: "why is the LINE bot silent?" — asks LINE and our own log, then says what to fix. */
export function LineDiagnosis({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const [result, setResult] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    setFailed(false);
    try {
      const { data } = await ctx.client.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch('/api/line/link?op=diagnose', {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      if (!res.ok) throw new Error('diagnose');
      setResult((await res.json()) as Result);
    } catch {
      setResult(null);
      setFailed(true);
    }
  };

  return (
    <section className="card admin-card" aria-labelledby="line-diag">
      <h2 id="line-diag">{t.lineDiagTitle}</h2>
      <p className="muted">{t.lineDiagIntro}</p>
      <div className="actions">
        <AsyncButton onClick={run}>{t.lineDiagRun}</AsyncButton>
      </div>
      {failed ? <Notice kind="error">{t.lineDiagFailed}</Notice> : null}
      {result ? (
        <>
          <ul className="member-list">
            {result.checks.map((c) => (
              <li key={c.id} className="member-row">
                <span aria-hidden="true">{ICON[c.level]}</span>{' '}
                <strong className="badge">
                  {(t as Record<string, string>)[`lineDiagLevel_${c.level}`]}
                </strong>{' '}
                {diagText(t, c)}
              </li>
            ))}
          </ul>
          <p className="muted">{fmt(t.lineDiagExpected, { url: result.expectedWebhook })}</p>
          <p className="muted">{t.lineDiagOa}</p>
        </>
      ) : null}
    </section>
  );
}
