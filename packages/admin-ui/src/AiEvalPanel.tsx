import { useState } from 'react';
import { fmt, errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { callAi } from './aiApi';

type Result = {
  id: string;
  task: string;
  about: string;
  ok: boolean;
  reason: string | null;
  ms: number;
  tokens: number;
};
type Summary = { task: string; passed: number; total: number };

/**
 * The evaluation of the AI route the administrator picked: golden questions per task, scored by code. Run it after changing a provider,
 * a model or an extra instruction and BEFORE shops rely on the change. It spends a few thousand tokens.
 */
export function AiEvalPanel({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const [res, setRes] = useState<{ results: Result[]; summary: Summary[] } | null>(null);
  const [err, setErr] = useState<ErrorKey | null>(null);
  const run = async () => {
    setErr(null);
    try {
      const r = await callAi<{ results: Result[]; summary: Summary[] }>(ctx.client, 'eval', {});
      setRes({
        results: Array.isArray(r.results) ? r.results : [],
        summary: Array.isArray(r.summary) ? r.summary : [],
      });
    } catch (e) {
      setErr(e instanceof Error && e.message === 'err_forbidden' ? 'err_forbidden' : 'err_unknown');
    }
  };
  const total = res?.results.length ?? 0;
  const passed = res?.results.filter((r) => r.ok).length ?? 0;
  const taskName = (id: string) => (t as Record<string, string>)[`aiTask_${id}`] ?? id;
  return (
    <section className="card admin-card" aria-label={t.aeTitle}>
      <h2>{t.aeTitle}</h2>
      <p className="muted">{t.aeIntro}</p>
      <AsyncButton onClick={run}>{t.aeRun}</AsyncButton>
      {err ? <Notice kind="error">{errorText(err, t)}</Notice> : null}
      {res ? (
        <>
          <p role="status">
            <strong>{fmt(t.aePassed, { p: passed, n: total })}</strong>
          </p>
          <ul className="member-list">
            {res.summary.map((s) => (
              <li key={s.task}>
                {taskName(s.task)}: {s.passed}/{s.total}
              </li>
            ))}
          </ul>
          <ul className="member-list">
            {res.results.map((r) => (
              <li key={r.id}>
                <span className="badge">{r.ok ? t.aePass : t.aeFail}</span> {r.about}
                {r.reason ? <span className="muted"> — {r.reason}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
