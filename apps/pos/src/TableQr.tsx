import { useState } from 'react';
import qrcode from 'qrcode-generator';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import type { PosTable } from './posData';

/** The address a guest's phone opens. Built from the token only; nothing about the shop is in the link. */
export const tableLink = (origin: string, token: string): string => `${origin}/t/${token}`;

/** A QR code as plain SVG shapes (no HTML injection): dark modules in ink on a white card. */
export function QrSvg({ value, label }: { value: string; label: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const cells: string[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) cells.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
  const size = n + quiet * 2;
  return (
    <svg
      className="qr-svg"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="var(--bp-surface)" />
      <path d={cells.join('')} fill="var(--bp-ink)" />
    </svg>
  );
}

/** The QR of one table: show, print, and replace the code (the old one stops working at once). */
export function TableQr({ ctx, table }: { ctx: PageContext; table: PosTable }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [rotated, setRotated] = useState(false);

  const show = async () => {
    setError(null);
    setOpen(true);
    const { data, error: err } = await ctx.client
      .from('dining_tables')
      .select('qr_token')
      .eq('id', table.id)
      .maybeSingle();
    const tok = (data as { qr_token?: unknown } | null)?.qr_token;
    if (err || typeof tok !== 'string') return setError('err_load_failed');
    setToken(tok);
  };

  const rotate = async () => {
    setError(null);
    setRotated(false);
    const { data, error: err } = await ctx.client.rpc('rotate_table_qr', { p_table: table.id });
    if (err || typeof data !== 'string')
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setToken(data);
    setRotated(true);
  };

  if (!open)
    return (
      <AsyncButton variant="secondary" onClick={show}>
        {t.tableQr}
      </AsyncButton>
    );

  const link = token ? tableLink(window.location.origin, token) : null;
  return (
    <div className="table-qr">
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {rotated ? <Notice kind="success">{t.tableQrRotated}</Notice> : null}
      {!link ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : (
        <>
          <div className="qr-print">
            <h3>{fmt(t.tableQrTitle, { table: table.name })}</h3>
            <QrSvg value={link} label={fmt(t.tableQrTitle, { table: table.name })} />
            <p className="muted mono qr-link">{link}</p>
          </div>
          <p className="muted">{t.tableQrHint}</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => window.print()}>
              {t.tableQrPrint}
            </button>
            <AsyncButton variant="secondary" onClick={rotate}>
              {t.tableQrRotate}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              {t.gsClose}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
