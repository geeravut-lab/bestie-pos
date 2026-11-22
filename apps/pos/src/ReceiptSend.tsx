import { useState } from 'react';
import { parseReceiptSend } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { useRemote } from '@bestie/admin-ui';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

/**
 * Send the receipt as a message (online only): an e-mail address typed here is used once and not stored; LINE only appears for a member who linked
 * her LINE and has not typed STOP. The text is built on the server from the frozen receipt.
 */
export function ReceiptSend({
  ctx,
  orderId,
  lang,
  online,
}: {
  ctx: PageContext;
  orderId: string;
  lang: 'th' | 'en';
  online: boolean;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const info = useRemote(async () => {
    if (!online) return null;
    const r = await ctx.client.rpc('receipt_send_data', { p_order: orderId });
    if (r.error) return null;
    return parseReceiptSend(r.data);
  }, `${orderId}:${online}`);
  if (!online) return <p className="muted no-print">{t.esOnline}</p>;
  if (!info.data) return null;

  const send = async (via: 'email' | 'line') => {
    setNote(null);
    const { data } = await ctx.client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return setNote({ kind: 'error', text: t.esFailed });
    const res = await fetch('/api/receipt/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: orderId,
        via,
        lang,
        ...(via === 'email' ? { email: email.trim() } : {}),
      }),
    });
    const b = (await res.json().catch(() => null)) as { ok?: boolean; outcome?: string } | null;
    if (res.ok && b?.ok === true)
      return setNote({ kind: 'success', text: via === 'email' ? t.esSentEmail : t.esSentLine });
    const o = b?.outcome;
    setNote({
      kind: 'error',
      text:
        o === 'not_configured'
          ? t.esNotConfigured
          : o === 'rejected' || res.status === 422
            ? t.esBadEmail
            : o === 'no_channel'
              ? t.esNoLine
              : t.esFailed,
    });
  };

  return (
    <section className="card admin-card no-print" aria-label={t.esTitle}>
      <h3>{t.esTitle}</h3>
      <p className="muted">{t.esIntro}</p>
      {note ? <Notice kind={note.kind}>{note.text}</Notice> : null}
      <div className="form-row">
        <label className="label" htmlFor="es-email">
          {t.esEmail}
        </label>
        <input
          id="es-email"
          className="field"
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="actions">
        <AsyncButton
          disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())}
          onClick={() => send('email')}
        >
          {t.esSendEmail}
        </AsyncButton>
        {info.data.memberLine ? (
          <AsyncButton variant="secondary" onClick={() => send('line')}>
            {t.esSendLine}
          </AsyncButton>
        ) : null}
      </div>
    </section>
  );
}
