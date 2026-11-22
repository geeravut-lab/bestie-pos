import { useState } from 'react';
import {
  PROVIDERS,
  PROVIDER_IDS,
  TASKS,
  TASK_IDS,
  aiSettingsToColumns,
  buildSystemPrompt,
  parseAiSettings,
  resolveRoute,
  validModelId,
} from '@bestie/core';
import type { AiSettings, ProviderId, ScreenProblem, TaskId } from '@bestie/core';
import { AppError, errorText, fmt, formatDateTime, toErrorCode, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { AiEvalPanel } from './AiEvalPanel';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { callAi } from './aiApi';
import { useRemote } from './useRemote';

const tx = (t: Dict, key: string, fallback = key): string =>
  (t as Record<string, string>)[key] ?? fallback;

type Loaded = {
  settings: AiSettings;
  keys: Record<ProviderId, boolean>;
  events: {
    id: number;
    provider: string;
    task: string;
    status: string;
    error_code: string | null;
    created_at: string;
  }[];
};

const AdminOnly = () => {
  const { t } = useI18n();
  return (
    <div className="admin-page">
      <Notice kind="error">{t.brandAdminOnly}</Notice>
    </div>
  );
};

// ── provider + model per task ───────────────────────────────────────────────
export function AiSettingsPage({
  ctx,
  onNavigate,
}: {
  ctx: PageContext;
  onNavigate: (path: string) => void;
}) {
  const { t, lang } = useI18n();
  const { status, data, reload } = useRemote<Loaded>(async () => {
    const [settings, statusRes, events] = await Promise.all([
      ctx.client.from('ai_settings').select('route_overrides, model_overrides').maybeSingle(),
      callAi<{ providers: Record<ProviderId, boolean> }>(ctx.client, 'status'),
      ctx.client
        .from('ai_events')
        .select('id, provider, task, status, error_code, created_at')
        .order('id', { ascending: false })
        .limit(50),
    ]);
    if (settings.error) throw new Error(settings.error.code ?? 'settings');
    const row = settings.data as { route_overrides?: unknown; model_overrides?: unknown } | null;
    return {
      settings: parseAiSettings(row?.route_overrides, row?.model_overrides),
      keys: statusRes.providers,
      events: (events.data ?? []) as Loaded['events'],
    };
  }, 'ai');
  useLiveSync(ctx.client, ['platform'], reload);

  const [draft, setDraft] = useState<AiSettings | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});

  if (!ctx.isPlatformAdmin) return <AdminOnly />;
  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  }

  const settings = draft ?? data.settings;
  const edit = (next: AiSettings) => {
    setDraft(next);
    setSaved(false);
  };
  const setRoute = (
    task: TaskId,
    patch: { primary?: ProviderId; fallback?: ProviderId | 'none' },
  ) =>
    edit({
      ...settings,
      routes: { ...settings.routes, [task]: { ...settings.routes[task], ...patch } },
    });
  const setModel = (provider: ProviderId, task: TaskId, model: string) =>
    edit({
      ...settings,
      models: {
        ...settings.models,
        [provider]: { ...settings.models[provider], [task]: model || undefined },
      },
    });

  const save = async () => {
    setError(null);
    setSaved(false);
    const bad = PROVIDER_IDS.some((p) =>
      Object.values(settings.models[p] ?? {}).some((m) => m && !validModelId(m)),
    );
    if (bad) return setError('err_invalid_input');
    // a provider without a key can never be chosen (it would only ever fail)
    for (const task of TASK_IDS) {
      const r = settings.routes[task];
      for (const p of [r?.primary, r?.fallback])
        if (p && p !== 'none' && !data.keys[p]) return setError('err_invalid_input');
    }
    const cols = aiSettingsToColumns(settings);
    const { data: rows, error: err } = await ctx.client
      .from('ai_settings')
      .update(cols)
      .eq('id', true)
      .select('id');
    if (err || rows?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setSaved(true);
    setDraft(null);
    reload();
  };

  const test = async (provider: ProviderId, task: TaskId) => {
    const model = settings.models[provider]?.[task] ?? TASKS[task].models[provider];
    const key = `${provider}:${task}`;
    try {
      const r = await callAi<{ ok: boolean; ms?: number; error?: string }>(ctx.client, 'test', {
        provider,
        model,
      });
      setTests((x) => ({ ...x, [key]: r.ok ? fmt(t.aiTestOk, { ms: r.ms ?? 0 }) : t.aiTestFail }));
    } catch (e) {
      setTests((x) => ({ ...x, [key]: errorText(toErrorCode(e), t) }));
    }
  };

  return (
    <div className="admin-page">
      <h1>{t.aiTitle}</h1>
      <p className="muted">{t.aiIntro}</p>
      <p className="muted hint">{t.aiKitchenNote}</p>

      <section className="card admin-card">
        <h2>{t.aiProviders}</h2>
        <ul className="plain-list">
          {PROVIDER_IDS.map((p) => (
            <li key={p} className="provider-row">
              <strong>{PROVIDERS[p].label}</strong>
              <span className={`badge ${data.keys[p] ? '' : 'badge-warn'}`}>
                {data.keys[p] ? `✓ ${t.aiKeySet}` : t.aiKeyMissing}
              </span>
              <span className="muted mono">{PROVIDERS[p].capabilities.join(' · ')}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card admin-card">
        <h2>{t.aiTasks}</h2>
        {TASK_IDS.map((task) => {
          const def = TASKS[task];
          const route = resolveRoute(task, settings, (p) => data.keys[p]);
          const r = settings.routes[task];
          const primary = r?.primary ?? def.primary;
          const fallback = r?.fallback ?? def.fallback ?? 'none';
          return (
            <fieldset key={task} className="audit-group">
              <legend>{tx(t, `aiTask_${task}`)}</legend>
              <p className="muted hint">{fmt(t.aiRoles, { roles: def.roles.join(', ') })}</p>
              {route?.primarySkipped ? <Notice kind="info">{t.aiSkipped}</Notice> : null}
              <div className="filters">
                <div className="form-row">
                  <label className="label" htmlFor={`pr-${task}`}>
                    {t.aiPrimary}
                  </label>
                  <select
                    id={`pr-${task}`}
                    className="field"
                    value={primary}
                    onChange={(e) => setRoute(task, { primary: e.target.value as ProviderId })}
                  >
                    {PROVIDER_IDS.map((p) => (
                      <option key={p} value={p} disabled={!data.keys[p]}>
                        {PROVIDERS[p].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label className="label" htmlFor={`fb-${task}`}>
                    {t.aiFallback}
                  </label>
                  <select
                    id={`fb-${task}`}
                    className="field"
                    value={fallback}

                    onChange={(e) =>
                      setRoute(task, { fallback: e.target.value as ProviderId | 'none' })
                    }
                  >
                    <option value="none">{t.aiNoFallback}</option>
                    {PROVIDER_IDS.filter((p) => p !== primary).map((p) => (
                      <option key={p} value={p} disabled={!data.keys[p]}>
                        {PROVIDERS[p].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="filters">
                {PROVIDER_IDS.map((p) => (
                  <div className="form-row" key={p}>
                    <label className="label" htmlFor={`md-${task}-${p}`}>
                      {fmt(t.aiModelFor, { provider: PROVIDERS[p].label })}
                    </label>
                    <input
                      id={`md-${task}-${p}`}
                      className="field mono"
                      value={settings.models[p]?.[task] ?? ''}
                      placeholder={def.models[p]}
                      onChange={(e) => setModel(p, task, e.target.value.trim())}
                    />
                    <span className="muted hint">{t.aiModelHint}</span>
                  </div>
                ))}
              </div>
              <div className="actions">
                <AsyncButton
                  variant="secondary"
                  disabled={!data.keys[primary]}
                  onClick={() => test(primary, task)}
                >
                  {t.aiTest}
                </AsyncButton>
                {tests[`${primary}:${task}`] ? (
                  <span role="status" className="muted">
                    {tests[`${primary}:${task}`]}
                  </span>
                ) : null}
              </div>
            </fieldset>
          );
        })}
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        {saved ? <Notice kind="success">{t.aiSaved}</Notice> : null}
        <div className="actions">
          <AsyncButton onClick={save}>{t.aiSave}</AsyncButton>
          <a
            className="btn btn-secondary"
            href="/admin/ai/prompts"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/admin/ai/prompts');
            }}
          >
            {t.aiPromptsLink}
          </a>
        </div>
      </section>

      <AiEvalPanel ctx={ctx} />

      <section className="card admin-card">
        <h2>{t.aiEvents}</h2>
        {data.events.length === 0 ? (
          <p className="muted">{t.aiNoEvents}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td className="tabular nowrap">{formatDateTime(lang, e.created_at)}</td>
                    <td>{e.status}</td>
                    <td>{e.provider}</td>
                    <td>{tx(t, `aiTask_${e.task}`, e.task)}</td>
                    <td className="mono">{e.error_code ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── extra instructions per task (two gates, history) ────────────────────────
export function AiPromptsPage({
  ctx,
  onNavigate,
}: {
  ctx: PageContext;
  onNavigate: (path: string) => void;
}) {
  const { t } = useI18n();
  const { status, data, reload } = useRemote<Record<string, string>>(async () => {
    const { data: rows, error } = await ctx.client
      .from('ai_prompt_versions')
      .select('task, body, id')
      .order('id', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.code ?? 'prompts');
    const latest: Record<string, string> = {};
    for (const r of (rows ?? []) as { task: string; body: string }[])
      if (!(r.task in latest)) latest[r.task] = r.body; // newest row per task; empty body = none
    return latest;
  }, 'prompts');

  if (!ctx.isPlatformAdmin) return <AdminOnly />;
  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  }
  return (
    <div className="admin-page">
      <a
        className="back-link"
        href="/ai"
        onClick={(e) => {
          e.preventDefault();
          onNavigate('/ai');
        }}
      >
        ← {t.aiTitle}
      </a>
      <h1>{t.promptsTitle}</h1>
      <p className="muted">{t.promptsIntro}</p>
      {TASK_IDS.map((task) => (
        <PromptCard key={task} ctx={ctx} task={task} current={data[task] ?? ''} onSaved={reload} />
      ))}
    </div>
  );
}

function PromptCard({
  ctx,
  task,
  current,
  onSaved,
}: {
  ctx: PageContext;
  task: TaskId;
  current: string;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(current);
  const [outcome, setOutcome] = useState<{
    kind: 'saved' | 'unsafe' | 'unavailable' | 'rejected';
    problems?: ScreenProblem[];
  } | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const def = TASKS[task];

  const insert = async (body: string, review: Record<string, unknown>) => {
    const { data: u } = await ctx.client.auth.getUser();
    const { error: err } = await ctx.client
      .from('ai_prompt_versions')
      .insert({ task, body, review, created_by: u.user?.id });
    if (err) throw new AppError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    onSaved();
  };

  const checkAndSave = async () => {
    setError(null);
    setOutcome(null);
    try {
      const r = await callAi<{
        result: 'safe' | 'unsafe' | 'unavailable' | 'rejected';
        problems: ScreenProblem[];
      }>(ctx.client, 'review', { task, text });
      if (r.result === 'safe') {
        await insert(text.trim(), { screener: 'passed', reviewer: 'safe' });
        return setOutcome({ kind: 'saved' });
      }
      setOutcome({ kind: r.result, problems: r.problems });
    } catch (e) {
      setError(toErrorCode(e));
    }
  };

  const remove = async () => {
    setError(null);
    setOutcome(null);
    try {
      await insert('', { removed: true });
      setText('');
      setOutcome({ kind: 'saved' });
    } catch (e) {
      setError(toErrorCode(e));
    }
  };

  return (
    <section className="card admin-card">
      <h2>{tx(t, `aiTask_${task}`)}</h2>
      {!def.editablePrompt ? (
        <p className="muted">{t.promptsNotEditable}</p>
      ) : (
        <>
          <div className="form-row">
            <label className="label" htmlFor={`pt-${task}`}>
              {t.promptsAddition}
            </label>
            <textarea
              id={`pt-${task}`}
              className="field area"
              rows={4}
              maxLength={1000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="muted hint">{text.length}/1000</span>
          </div>
          {outcome?.kind === 'saved' ? <Notice kind="success">{t.promptsSaved}</Notice> : null}
          {outcome?.kind === 'unsafe' ? <Notice kind="error">{t.promptsUnsafe}</Notice> : null}
          {outcome?.kind === 'unavailable' ? (
            <Notice kind="info">{t.promptsUnavailable}</Notice>
          ) : null}
          {outcome?.kind === 'rejected' ? (
            <Notice kind="error">
              {t.promptsRejected}{' '}
              {(outcome.problems ?? []).map((p) => tx(t, `aiProblem_${p}`, p)).join(' · ')}
            </Notice>
          ) : null}
          {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
          <div className="actions">
            <AsyncButton disabled={text.trim() === current.trim()} onClick={checkAndSave}>
              {t.promptsCheckSave}
            </AsyncButton>
            {current ? (
              <AsyncButton variant="secondary" onClick={remove}>
                {t.promptsRemove}
              </AsyncButton>
            ) : null}
          </div>
        </>
      )}
      <details>
        <summary>{t.promptsActual}</summary>
        <pre className="prompt-preview">{buildSystemPrompt(task, current)}</pre>
      </details>
    </section>
  );
}
