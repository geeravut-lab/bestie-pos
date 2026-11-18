import { useState } from 'react';
import {
  addressParts,
  cryptoAddressValid,
  formatTHB,
  formatUnits,
  priceInputValue,
  toCsv,
} from '@bestie/core';
import type { CryptoNetwork } from '@bestie/core';
import { errorText, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Wallet = { id: string; network: CryptoNetwork; address: string; label: string | null };
type Change = { id: string; network: CryptoNetwork; new_address: string; requested_by: string };
type KycRow = {
  id: string;
  tier: 'T1' | 'T2';
  full_name: string;
  nationality: string;
  passport_no: string;
  contact: string;
  source_of_funds: string | null;
  created_by: string | null;
};
type TransferRow = {
  id: string;
  wallet_id: string;
  network: CryptoNetwork;
  tx_hash: string;
  from_address: string;
  amount_units: number;
  confirmations: number;
  reason: string | null;
  block_time: string;
};
type RequestRow = {
  id: string;
  wallet_id: string;
  thb_amount: number;
  amount_units: number;
  status: string;
  created_at: string;
};
type FlagRow = { id: string; rule: string; created_at: string };

const short = (a: string) => {
  const p = addressParts(a);
  return `${p.head}…${p.tail}`;
};

/** Crypto top-up back office: company wallets (two-person change), KYC approvals, transfers needing review, flags, AML export. */
export function CryptoPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const can = ctx.isOwner || ctx.permissions.includes('credit.adjust');

  const data = useRemote(async () => {
    if (!can) return null;
    const c = ctx.client;
    const [stores, wallets, changes, kyc, transfers, requests, flags] = await Promise.all([
      c
        .from('stores')
        .select('id')
        .eq('org_id', ctx.orgId)
        .is('deleted_at', null)
        .order('created_at'),
      c
        .from('crypto_wallets')
        .select('id, network, address, label')
        .eq('org_id', ctx.orgId)
        .eq('active', true),
      c
        .from('crypto_wallet_changes')
        .select('id, network, new_address, requested_by')
        .eq('org_id', ctx.orgId)
        .eq('status', 'pending'),
      c
        .from('crypto_kyc')
        .select(
          'id, tier, full_name, nationality, passport_no, contact, source_of_funds, created_by',
        )
        .eq('org_id', ctx.orgId)
        .eq('status', 'pending'),
      c
        .from('crypto_transfers')
        .select(
          'id, wallet_id, network, tx_hash, from_address, amount_units, confirmations, reason, block_time',
        )
        .eq('org_id', ctx.orgId)
        .eq('status', 'review'),
      c
        .from('crypto_requests')
        .select('id, wallet_id, thb_amount, amount_units, status, created_at')
        .eq('org_id', ctx.orgId)
        .in('status', ['open', 'paid_pending', 'expired', 'review']),
      c
        .from('crypto_flags')
        .select('id, rule, created_at')
        .eq('org_id', ctx.orgId)
        .eq('status', 'open'),
    ]);
    if (stores.error || wallets.error) throw new Error('load');
    return {
      storeId:
        ctx.homeStoreId ?? ctx.storeId ?? (stores.data as { id: string }[] | null)?.[0]?.id ?? '',
      wallets: (wallets.data ?? []) as Wallet[],
      changes: (changes.data ?? []) as Change[],
      kyc: (kyc.data ?? []) as KycRow[],
      transfers: (transfers.data ?? []) as TransferRow[],
      requests: (requests.data ?? []) as RequestRow[],
      flags: (flags.data ?? []) as FlagRow[],
    };
  }, `${ctx.orgId}:${can}`);

  if (!can)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.cryNoAccess}</Notice>
      </div>
    );
  if (data.status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (data.status === 'error' || !data.data)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={data.reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  const d = data.data;
  return (
    <div className="admin-page">
      <h1>{t.cryPageTitle}</h1>
      <Notice kind="info">{t.cryRule}</Notice>
      <WalletsCard
        ctx={ctx}
        storeId={d.storeId}
        wallets={d.wallets}
        changes={d.changes}
        onChanged={data.reload}
      />
      <KycQueue ctx={ctx} rows={d.kyc} onChanged={data.reload} />
      <ReviewQueue
        ctx={ctx}
        transfers={d.transfers}
        requests={d.requests}
        onChanged={data.reload}
      />
      <FlagsCard flags={d.flags} />
      <AmlExport ctx={ctx} />
    </div>
  );
}

function WalletsCard({
  ctx,
  storeId,
  wallets,
  changes,
  onChanged,
}: {
  ctx: PageContext;
  storeId: string;
  wallets: Wallet[];
  changes: Change[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [address, setAddress] = useState<Record<CryptoNetwork, string>>({ tron: '', ethereum: '' });
  const [bad, setBad] = useState<CryptoNetwork | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const norm = (n: CryptoNetwork, a: string) =>
    n === 'ethereum' ? a.trim().toLowerCase() : a.trim();
  const save = async (n: CryptoNetwork, change: boolean) => {
    setError(null);
    setBad(null);
    const a = norm(n, address[n]);
    if (!cryptoAddressValid(n, a)) return setBad(n);
    const { error: err } = await ctx.client.rpc(
      change ? 'crypto_wallet_change_request' : 'crypto_set_wallet',
      {
        p: { store_id: storeId, network: n, address: a },
      },
    );
    if (err)
      return setError(
        err.code === '42501' || err.code === '0A000' ? 'err_forbidden' : 'err_save_failed',
      );
    setAddress((s) => ({ ...s, [n]: '' }));
    onChanged();
  };
  const approve = async (id: string) => {
    setError(null);
    const { error: err } = await ctx.client.rpc('crypto_wallet_change_approve', { p_change: id });
    if (err) return setError(err.code === '23514' ? 'err_forbidden' : 'err_save_failed');
    onChanged();
  };

  return (
    <section className="card admin-card" aria-label={t.cryWallets}>
      <h2>{t.cryWallets}</h2>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {(['tron', 'ethereum'] as const).map((n) => {
        const w = wallets.find((x) => x.network === n);
        const pending = changes.find((c) => c.network === n);
        const parts = w ? addressParts(w.address) : null;
        return (
          <div key={n} className="crypto-wallet">
            <h3>{n === 'tron' ? 'USDT · TRON (TRC-20)' : 'USDT · Ethereum (ERC-20)'}</h3>
            {w && parts ? (
              <p className="mono crypto-address">
                <strong className="crypto-end">{parts.head}</strong>
                {parts.middle}
                <strong className="crypto-end">{parts.tail}</strong>
              </p>
            ) : (
              <p className="muted">{t.cryWalletNone}</p>
            )}
            {w ? <p className="muted">{t.cryWalletCard}</p> : null}
            {pending ? (
              <div className="confirm-box">
                <p>{fmt(t.cryWalletPending, { address: short(pending.new_address) })}</p>
                <AsyncButton onClick={() => approve(pending.id)}>{t.cryWalletApprove}</AsyncButton>
                <p className="muted hint">{t.cryWalletSame}</p>
              </div>
            ) : (
              <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
                <div className="form-row">
                  <label className="label" htmlFor={`cw-${n}`}>
                    {t.cryWalletAddress} ({n})
                  </label>
                  <input
                    id={`cw-${n}`}
                    className="field mono"
                    value={address[n]}
                    onChange={(e) => setAddress((s) => ({ ...s, [n]: e.target.value }))}
                  />
                </div>
                {bad === n ? <Notice kind="error">{t.cryWalletBad}</Notice> : null}
                <AsyncButton variant={w ? 'secondary' : 'primary'} onClick={() => save(n, !!w)}>
                  {w ? t.cryWalletChange : t.cryWalletSet}
                </AsyncButton>
              </form>
            )}
          </div>
        );
      })}
    </section>
  );
}

function KycQueue({
  ctx,
  rows,
  onChanged,
}: {
  ctx: PageContext;
  rows: KycRow[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [owner, setOwner] = useState(false);
  const decide = async (id: string, approve: boolean) => {
    setError(null);
    setOwner(false);
    const { error: err } = await ctx.client.rpc('crypto_kyc_decide', {
      p_kyc: id,
      p_approve: approve,
      p_note: note.trim() || null,
    });
    if (err) {
      if (err.code === '42501') return setOwner(true);
      return setError('err_save_failed');
    }
    setNote('');
    onChanged();
  };
  return (
    <section className="card admin-card" aria-label={t.cryKycQueue}>
      <h2>{t.cryKycQueue}</h2>
      {rows.length === 0 ? <p className="muted">{t.cryKycQueueEmpty}</p> : null}
      {owner ? <Notice kind="error">{t.cryKycOwnerOnly}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <ul className="member-list">
        {rows.map((k) => (
          <li key={k.id} className="member-row">
            <div className="member-head">
              <strong>{k.full_name}</strong>
              <span className="badge">{k.tier}</span>
              <span className="muted">{k.nationality}</span>
            </div>
            <p className="muted mono">
              {k.passport_no} · {k.contact}
            </p>
            {k.source_of_funds ? <p className="muted">{k.source_of_funds}</p> : null}
            <div className="form-row">
              <label className="label" htmlFor={`kn-${k.id}`}>
                {t.cryKycNote}
              </label>
              <input
                id={`kn-${k.id}`}
                className="field"
                value={note}
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <div className="actions">
              <AsyncButton onClick={() => decide(k.id, true)}>{t.cryKycApprove}</AsyncButton>
              <AsyncButton variant="secondary" onClick={() => decide(k.id, false)}>
                {t.cryKycReject}
              </AsyncButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewQueue({
  ctx,
  transfers,
  requests,
  onChanged,
}: {
  ctx: PageContext;
  transfers: TransferRow[];
  requests: RequestRow[];
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState<ErrorKey | null>(null);
  const [msg, setMsg] = useState<'done' | 'final' | 'note' | null>(null);

  const resolve = async (tr: TransferRow, action: 'credit' | 'reject') => {
    setError(null);
    setMsg(null);
    const n = (note[tr.id] ?? '').trim();
    if (n.length === 0) return setMsg('note');
    const { error: err } = await ctx.client.rpc('crypto_resolve_review', {
      p_transfer: tr.id,
      p_action: action,
      p_request: action === 'credit' ? (choice[tr.id] ?? null) : null,
      p_note: n,
    });
    if (err) {
      if (err.code === '23514') return setMsg('final');
      if (err.code === '22023') return setMsg('note');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setMsg('done');
    onChanged();
  };

  return (
    <section className="card admin-card" aria-label={t.cryReviewQueue}>
      <h2>{t.cryReviewQueue}</h2>
      {transfers.length === 0 ? <p className="muted">{t.cryReviewEmpty}</p> : null}
      {msg === 'done' ? <Notice kind="success">{t.cryReviewDone}</Notice> : null}
      {msg === 'final' ? <Notice kind="error">{t.cryReviewFinal}</Notice> : null}
      {msg === 'note' ? <Notice kind="error">{t.cryReviewNote}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <ul className="member-list">
        {transfers.map((tr) => {
          const reason = (t as Record<string, string>)[`cryReason_${tr.reason}`] ?? tr.reason ?? '';
          const cands = requests.filter((r) => r.wallet_id === tr.wallet_id);
          return (
            <li key={tr.id} className="member-row">
              <div className="member-head">
                <strong className="tabular">{formatUnits(tr.amount_units)} USDT</strong>
                <span className="badge badge-warn">{reason}</span>
                <span className="muted">{formatDateTime(lang, tr.block_time)}</span>
              </div>
              <p className="muted mono">
                tx {short(tr.tx_hash)} · from {short(tr.from_address)} · {tr.confirmations}
              </p>
              <div className="form-row">
                <label className="label" htmlFor={`rr-${tr.id}`}>
                  {t.cryReviewRequest}
                </label>
                <select
                  id={`rr-${tr.id}`}
                  className="field"
                  value={choice[tr.id] ?? ''}
                  onChange={(e) => setChoice((s) => ({ ...s, [tr.id]: e.target.value }))}
                >
                  <option value="" />
                  {cands.map((r) => (
                    <option key={r.id} value={r.id}>
                      {formatUnits(r.amount_units)} USDT ·{' '}
                      {formatTHB(r.thb_amount, lang === 'th' ? 'th-TH' : 'en-GB')} · {r.status}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label className="label" htmlFor={`rn-${tr.id}`}>
                  {t.cryReviewNote}
                </label>
                <input
                  id={`rn-${tr.id}`}
                  className="field"
                  maxLength={200}
                  value={note[tr.id] ?? ''}
                  onChange={(e) => setNote((s) => ({ ...s, [tr.id]: e.target.value }))}
                />
              </div>
              <div className="actions">
                <AsyncButton disabled={!choice[tr.id]} onClick={() => resolve(tr, 'credit')}>
                  {t.cryReviewCredit}
                </AsyncButton>
                <AsyncButton variant="secondary" onClick={() => resolve(tr, 'reject')}>
                  {t.cryReviewReject}
                </AsyncButton>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FlagsCard({ flags }: { flags: FlagRow[] }) {
  const { t, lang } = useI18n();
  return (
    <section className="card admin-card" aria-label={t.cryFlags}>
      <h2>{t.cryFlags}</h2>
      {flags.length === 0 ? <p className="muted">{t.cryFlagsEmpty}</p> : null}
      <ul className="member-list">
        {flags.map((f) => (
          <li key={f.id} className="member-row">
            <span>{(t as Record<string, string>)[`cryFlag_${f.rule}`] ?? f.rule}</span>{' '}
            <span className="muted">{formatDateTime(lang, f.created_at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function AmlExport({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const [from, setFrom] = useState(() => day(-30));
  const [to, setTo] = useState(() => day(0));
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  const run = async () => {
    setError(null);
    setEmpty(false);
    const { data, error: err } = await ctx.client.rpc('crypto_aml_report', {
      p_org: ctx.orgId,
      p_from: from,
      p_to: to,
    });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_load_failed');
    const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    if (rows.length === 0) return setEmpty(true);
    const csv = toCsv(
      [
        'credited_at',
        'request_id',
        'customer',
        'nationality',
        'passport_last4',
        'tier',
        'contact',
        'network',
        'token',
        'tx_hash',
        'from_address',
        'to_address',
        'usdt',
        'thb',
        'rate_thb_per_usdt',
        'flags',
      ],
      rows.map((r) => [
        r.credited_at,
        r.request_id,
        r.customer,
        r.nationality,
        r.passport_last4,
        r.tier,
        r.contact,
        r.network,
        r.token,
        r.tx_hash,
        r.from_address,
        r.to_address,
        typeof r.units === 'number' ? formatUnits(r.units) : '',
        typeof r.thb === 'number' ? priceInputValue(r.thb) : '',
        typeof r.rate === 'number' ? priceInputValue(r.rate) : '',
        Array.isArray(r.flags) ? r.flags.join('|') : '',
      ]),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `aml-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    await ctx.client.rpc('write_audit', {
      p_org: ctx.orgId,
      p_store: null,
      p_action: 'export.report',
      p_entity: 'crypto_aml_report',
      p_entity_id: null,
      p_detail: { rows: rows.length, from, to },
    });
  };

  return (
    <section className="card admin-card" aria-label={t.cryAml}>
      <h2>{t.cryAml}</h2>
      <div className="filters">
        <div className="form-row">
          <label className="label" htmlFor="aml-from">
            {t.repFrom}
          </label>
          <input
            id="aml-from"
            className="field"
            type="date"
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="aml-to">
            {t.repTo}
          </label>
          <input
            id="aml-to"
            className="field"
            type="date"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </div>
      </div>
      {empty ? <p className="muted">{t.cryAmlEmpty}</p> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <AsyncButton onClick={run}>{t.cryAmlExport}</AsyncButton>
      <p className="muted hint">{t.cryAmlNote}</p>
    </section>
  );
}
