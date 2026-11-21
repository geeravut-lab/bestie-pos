import { useState } from 'react';
import {
  HEALTH_TEXT,
  HEALTH_TEXT_MAX,
  HEALTH_YES_NO,
  healthFlags,
  healthIntakePayload,
  parseHealthAnswers,
} from '@bestie/core';
import type { HealthAnswers } from '@bestie/core';
import { errorText, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

type Note = { id: string; kind: string; title: string; body: string; createdAt: string };
type Intake = { id: string; answers: HealthAnswers; signedName: string; signedAt: string };

/** A member's service notes (colour formula …) and the spa's health form with the guest's consent and typed signature. */
export function ClientRecordPanel({ ctx, customerId }: { ctx: PageContext; customerId: string }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const moduleOn = ctx.isModuleOn ? ctx.isModuleOn('appointments') : true;
  const canWrite = ctx.isOwner || ctx.permissions.includes('order.create');
  const canErase = ctx.isOwner || ctx.permissions.includes('staff.manage');
  const [kind, setKind] = useState<'formula' | 'note'>('formula');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [form, setForm] = useState<{
    answers: HealthAnswers;
    consent: boolean;
    name: string;
  } | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [bad, setBad] = useState<'note' | 'health' | null>(null);

  const data = useRemote<{ notes: Note[]; intakes: Intake[] }>(async () => {
    const [n, h] = await Promise.all([
      ctx.client
        .from('client_notes')
        .select('id, kind, title, body, created_at')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(50),
      ctx.client
        .from('health_intakes')
        .select('id, answers, signed_name, signed_at')
        .eq('customer_id', customerId)
        .order('signed_at', { ascending: false })
        .limit(5),
    ]);
    if (n.error || h.error) throw new Error('load');
    return {
      notes: ((n.data ?? []) as Record<string, string>[]).map((x) => ({
        id: String(x.id),
        kind: String(x.kind),
        title: String(x.title),
        body: String(x.body),
        createdAt: String(x.created_at),
      })),
      intakes: ((h.data ?? []) as Record<string, unknown>[]).map((x) => ({
        id: String(x.id),
        answers: parseHealthAnswers(x.answers),
        signedName: String(x.signed_name),
        signedAt: String(x.signed_at),
      })),
    };
  }, `client:${customerId}`);

  if (!moduleOn) return null;
  const fail = (code: string | undefined): ErrorKey =>
    code === '42501' ? 'err_forbidden' : 'err_save_failed';

  const addNote = async () => {
    setError(null);
    setBad(null);
    if (!storeId || title.trim() === '' || body.trim() === '') return setBad('note');
    const { error: err } = await ctx.client.rpc('add_client_note', {
      p: {
        store_id: storeId,
        customer_id: customerId,
        kind,
        title: title.trim(),
        body: body.trim(),
      },
    });
    if (err) return setError(fail(err.code));
    setTitle('');
    setBody('');
    data.reload();
  };
  const saveHealth = async () => {
    setError(null);
    setBad(null);
    const payload =
      form && storeId
        ? healthIntakePayload({
            storeId,
            customerId,
            answers: form.answers,
            consent: form.consent,
            signedName: form.name,
          })
        : null;
    if (!payload) return setBad('health');
    const { error: err } = await ctx.client.rpc('save_health_intake', { p: payload });
    if (err) return setError(fail(err.code));
    setForm(null);
    data.reload();
  };
  const erase = async (kindName: 'note' | 'health', id: string) => {
    setError(null);
    const { error: err } = await ctx.client.rpc('delete_client_record', {
      p_kind: kindName,
      p_id: id,
    });
    if (err) return setError(fail(err.code));
    data.reload();
  };

  const latest = data.data?.intakes[0];
  const flags = latest ? healthFlags(latest.answers) : null;

  return (
    <section className="card admin-card" aria-label={t.crTitle}>
      <h3>{t.crTitle}</h3>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      <h4>{t.crNotes}</h4>
      {data.data && data.data.notes.length === 0 ? <p className="muted">{t.crNotesNone}</p> : null}
      <ul className="member-list">
        {(data.data?.notes ?? []).map((n) => (
          <li key={n.id} className="member-row">
            <div className="member-head">
              <strong>{n.title}</strong>
              <span className="badge">{tx(t, `crKind_${n.kind}`)}</span>
              <span className="muted">{formatDateTime(lang, n.createdAt)}</span>
            </div>
            <p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
            {canErase ? (
              <AsyncButton variant="secondary" onClick={() => erase('note', n.id)}>
                {t.crErase}
              </AsyncButton>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <div className="form-row">
          <label className="label" htmlFor="cr-kind">
            {t.crKind}
          </label>
          <select
            id="cr-kind"
            className="field"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'formula' | 'note')}
          >
            <option value="formula">{t.crKind_formula}</option>
            <option value="note">{t.crKind_note}</option>
          </select>
          <label className="label" htmlFor="cr-title">
            {t.crNoteTitle}
          </label>
          <input
            id="cr-title"
            className="field"
            maxLength={80}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label className="label" htmlFor="cr-body">
            {t.crNoteBody}
          </label>
          <textarea
            id="cr-body"
            className="field"
            rows={3}
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {bad === 'note' ? <Notice kind="error">{t.crNoteBad}</Notice> : null}
          <AsyncButton variant="secondary" onClick={addNote}>
            {t.crNoteAdd}
          </AsyncButton>
        </div>
      ) : null}

      <h4>{t.crHealth}</h4>
      {data.data && !latest ? <p className="muted">{t.crHealthNone}</p> : null}
      {latest && flags ? (
        <div>
          <p className="muted">
            {t.crHealthLatest}:{' '}
            {fmt(t.crHealthSigned, {
              name: latest.signedName,
              when: formatDateTime(lang, latest.signedAt),
            })}
          </p>
          <ul>
            {flags.yes.map((k) => (
              <li key={k}>
                <strong>{tx(t, `crHealth_${k}`)}:</strong> {t.crYes}
              </li>
            ))}
            {flags.text.map((k) => (
              <li key={k}>
                <strong>{tx(t, `crHealth_${k}`)}:</strong> {latest.answers[k]}
              </li>
            ))}
          </ul>
          {canErase ? (
            <AsyncButton variant="secondary" onClick={() => erase('health', latest.id)}>
              {t.crErase}
            </AsyncButton>
          ) : null}
        </div>
      ) : null}
      {canWrite && !form ? (
        <AsyncButton
          variant="secondary"
          onClick={() => setForm({ answers: {}, consent: false, name: '' })}
        >
          {t.crHealthNew}
        </AsyncButton>
      ) : null}
      {form ? (
        <div className="form-row">
          <p className="muted">{t.crHealthIntro}</p>
          {HEALTH_YES_NO.map((k) => (
            <label key={k} className="check">
              <input
                type="checkbox"
                checked={form.answers[k] === true}
                onChange={(e) =>
                  setForm({ ...form, answers: { ...form.answers, [k]: e.target.checked } })
                }
              />{' '}
              {tx(t, `crHealth_${k}`)}
            </label>
          ))}
          {HEALTH_TEXT.map((k) => (
            <div key={k} className="form-row">
              <label className="label" htmlFor={`cr-h-${k}`}>
                {tx(t, `crHealth_${k}`)}
              </label>
              <input
                id={`cr-h-${k}`}
                className="field"
                maxLength={HEALTH_TEXT_MAX}
                value={form.answers[k] ?? ''}
                onChange={(e) =>
                  setForm({ ...form, answers: { ...form.answers, [k]: e.target.value } })
                }
              />
            </div>
          ))}
          <label className="check">
            <input
              type="checkbox"
              checked={form.consent}
              onChange={(e) => setForm({ ...form, consent: e.target.checked })}
            />{' '}
            {t.crConsent}
          </label>
          <label className="label" htmlFor="cr-sign">
            {t.crSignName}
          </label>
          <input
            id="cr-sign"
            className="field"
            maxLength={80}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          {bad === 'health' ? <Notice kind="error">{t.crHealthBad}</Notice> : null}
          <div className="actions">
            <AsyncButton onClick={saveHealth}>{t.crHealthSave}</AsyncButton>
            <AsyncButton variant="secondary" onClick={() => setForm(null)}>
              {t.crCancel}
            </AsyncButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}
