import { useEffect, useRef, useState } from 'react';
import { errorText, fmt, formatDateTime, toErrorCode, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AppError } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { useAuth } from './context';

type LinkStatus = {
  available: boolean;
  basicId?: string;
  channel?: {
    status: 'pending' | 'active' | 'stopped';
    expiresAt: string | null;
    lastError: string | null;
  } | null;
};

/** Calls /api/line/link with the user's JWT. Only codes reach the screen, never provider text. */
async function callLink<T>(token: string, method: 'GET' | 'POST' | 'DELETE', qs = ''): Promise<T> {
  const res = await fetch(`/api/line/link${qs}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) throw new AppError('err_rate_limited');
  if (!res.ok) throw new AppError(res.status === 403 ? 'err_forbidden' : 'err_unknown');
  return (await res.json()) as T;
}

const POLL_MS = 4000;

/**
 * "Connect LINE" (LINE-ACCOUNT-LINKING §8): four numbered steps — copy the code, add the OA, send the code (the chat opens
 * with it pre-typed), wait here. While a code is on screen the status is polled every 4 s until it expires; the real code is
 * kept in memory only and shown ONCE (a refresh asks for a new one).
 */
export function LineConnect() {
  const { t, lang } = useI18n();
  const { client } = useAuth();
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [code, setCode] = useState<{ value: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const token = useRef<string | null>(null);

  const token_ = async (): Promise<string> => {
    const { data } = await client!.auth.getSession();
    token.current = data.session?.access_token ?? null;
    if (!token.current) throw new AppError('err_forbidden');
    return token.current;
  };
  const refreshStatus = async () => setStatus(await callLink<LinkStatus>(await token_(), 'GET'));

  useEffect(() => {
    if (!client) return;
    let alive = true;
    void (async () => {
      try {
        const { data } = await client.auth.getSession();
        const tk = data.session?.access_token;
        if (!tk) return;
        const s = await callLink<LinkStatus>(tk, 'GET');
        if (alive) setStatus(s);
      } catch (e) {
        if (alive) setError(toErrorCode(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [client]);

  // poll while a code is on screen
  const waiting = code !== null && status?.channel?.status !== 'active';
  useEffect(() => {
    if (!waiting || !code || !client) return;
    const id = setInterval(() => {
      if (Date.now() > new Date(code.expiresAt).getTime()) return;
      void (async () => {
        try {
          const { data } = await client.auth.getSession();
          if (!data.session) return;
          const s = await callLink<LinkStatus>(data.session.access_token, 'GET');
          setStatus(s);
          if (s.channel?.status === 'active') setCode(null);
        } catch {
          /* keep trying until the code expires */
        }
      })();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, code, client]);

  const start = async () => {
    setError(null);
    setNotice(null);
    try {
      const r = await callLink<{ code: string; expiresAt: string; basicId: string }>(
        await token_(),
        'POST',
      );
      setCode({ value: r.code, expiresAt: r.expiresAt });
      setStatus((s) => ({
        available: true,
        basicId: r.basicId,
        channel: { status: 'pending', expiresAt: r.expiresAt, lastError: null },
        ...(s ? {} : {}),
      }));
    } catch (e) {
      setError(toErrorCode(e));
    }
  };
  const disconnect = async () => {
    setError(null);
    setNotice(null);
    try {
      await callLink(await token_(), 'DELETE');
      setCode(null);
      await refreshStatus();
    } catch (e) {
      setError(toErrorCode(e));
    }
  };
  const sendTest = async () => {
    setError(null);
    setNotice(null);
    try {
      const r = await callLink<{ outcome?: string }>(await token_(), 'POST', '?op=test');
      setNotice(r.outcome === 'sent' ? t.lineTestSent : t.lineTestFailed);
    } catch (e) {
      setError(toErrorCode(e));
    }
  };
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.value);
      setCopied(true);
    } catch {
      /* the code is selectable text as well */
    }
  };

  if (!status) {
    return (
      <section className="card auth-card">
        <h2>{t.lineTitle}</h2>
        {error ? (
          <p className="notice notice-error" role="alert">
            {errorText(error, t)}
          </p>
        ) : (
          <p className="sso-working" role="status">
            <Spinner /> {t.loading}
          </p>
        )}
      </section>
    );
  }
  if (!status.available) {
    return (
      <section className="card auth-card">
        <h2>{t.lineTitle}</h2>
        <p className="notice notice-info" role="status">
          <span aria-hidden="true">ⓘ</span> {t.lineUnavailable}
        </p>
      </section>
    );
  }

  const state = status.channel?.status;
  const basic = encodeURIComponent(status.basicId ?? '');
  return (
    <section className="card auth-card">
      <h2>{t.lineTitle}</h2>

      {state === 'active' ? (
        <>
          <p className="notice notice-success" role="status">
            <span aria-hidden="true">✓</span> {t.lineConnected}
          </p>
          <div className="actions">
            <AsyncButton variant="secondary" onClick={sendTest}>
              {t.lineTest}
            </AsyncButton>
            <AsyncButton variant="secondary" onClick={disconnect}>
              {t.lineDisconnect}
            </AsyncButton>
          </div>
        </>
      ) : (
        <>
          {state === 'stopped' ? (
            <p className="notice notice-error" role="alert">
              <span aria-hidden="true">✕</span>{' '}
              {fmt(t.lineStopped, { reason: status.channel?.lastError ?? '' })}
            </p>
          ) : null}
          {code ? (
            <ol className="line-steps" aria-label={t.lineTitle}>
              <li>
                <span className="line-step-title">{t.lineStep1}</span>
                <code className="line-code" aria-label={t.lineCodeLabel}>
                  {code.value}
                </code>
                <button type="button" className="link-button" onClick={copy}>
                  {copied ? t.lineCopied : t.lineCopy}
                </button>
                <span className="muted hint">
                  {fmt(t.lineExpires, { time: formatDateTime(lang, code.expiresAt) })}
                </span>
              </li>
              <li>
                <span className="line-step-title">{t.lineStep2}</span>
                <a
                  className="btn btn-secondary"
                  href={`https://line.me/R/ti/p/${basic}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.lineAddFriend}
                </a>
              </li>
              <li>
                <span className="line-step-title">{t.lineStep3}</span>
                <a
                  className="btn"
                  href={`https://line.me/R/oaMessage/${basic}/?${encodeURIComponent(code.value)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.lineSendCode}
                </a>
              </li>
              <li>
                <span className="line-step-title">{t.lineStep4}</span>
                <span className="muted">
                  <Spinner /> {t.lineStep4Body}
                </span>
              </li>
            </ol>
          ) : null}
          <AsyncButton variant={code ? 'secondary' : 'primary'} onClick={start}>
            {code || state === 'pending' ? t.lineNewCode : t.lineConnect}
          </AsyncButton>
        </>
      )}
      {notice ? (
        <p className="notice notice-success" role="status">
          <span aria-hidden="true">✓</span> {notice}
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          <span aria-hidden="true">✕</span> {errorText(error, t)}
        </p>
      ) : null}
    </section>
  );
}
