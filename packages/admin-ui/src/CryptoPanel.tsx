import { useEffect, useState } from 'react';
import {
  CRYPTO_NETWORKS,
  addressParts,
  cryptoAddressValid,
  formatTHB,
  isCryptoNetwork,
  parsePriceInput,
} from '@bestie/core';
import type { CryptoNetwork, CustomerCard } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { getDeviceBinding } from '@bestie/offline';
import { AsyncButton, QrSvg, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Kyc = {
  kyc_id: string;
  tier: 'T1' | 'T2';
  status: 'pending' | 'approved' | 'rejected';
} | null;
type Req = {
  request_id: string;
  network: CryptoNetwork;
  token_label: string;
  address: string;
  units_text: string;
  thb: number;
  rate: number;
  expires_at: string;
  qr: string;
};
type ReqStatus = 'open' | 'paid_pending' | 'credited' | 'expired' | 'review' | 'cancelled';

const POLL_MS = 5000;
const clock = () => Date.now();

function useNow(everyMs: number): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Crypto top-up of one member's Bestie Credit (USDT on Tron / Ethereum). Shown only where the shop switched the
 * `credit.topup.crypto` module on; the server still checks the module, the Credit module and the lawyer's sign-off.
 */
export function CryptoPanel({ ctx, card }: { ctx: PageContext; card: CustomerCard }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const storeId = getDeviceBinding()?.storeId ?? ctx.homeStoreId ?? ctx.storeId;
  const canTake = ctx.isOwner || ctx.permissions.includes('payment.take');
  const [req, setReq] = useState<Req | null>(null);
  const [status, setStatus] = useState<ReqStatus>('open');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [network, setNetwork] = useState<CryptoNetwork>('tron');
  const [amount, setAmount] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const now = useNow(1000);

  const state = useRemote(
    async () => {
      if (!storeId) return null;
      const s = await ctx.client
        .from('stores')
        .select('id, module_overrides')
        .eq('id', storeId)
        .maybeSingle();
      const row = s.data as { id: string; module_overrides: Record<string, unknown> } | null;
      if (s.error) throw new Error('load');
      if (!row || row.module_overrides?.['credit.topup.crypto'] !== true) return null;
      const k = await ctx.client.rpc('crypto_customer_status', { p_customer: card.id });
      if (k.error) throw new Error('load');
      return { storeId: row.id, kyc: (k.data ?? null) as Kyc };
    },
    `${card.id}:${storeId ?? ''}`,
  );

  // while a request is live, ask the database every few seconds what happened to it
  const reqId = req?.request_id ?? null;
  const live = status === 'open' || status === 'paid_pending';
  useEffect(() => {
    if (!reqId || !live) return;
    let alive = true;
    const tick = async () => {
      const { data } = await ctx.client
        .from('crypto_requests')
        .select('status')
        .eq('id', reqId)
        .maybeSingle();
      const st = (data as { status?: ReqStatus } | null)?.status;
      if (alive && st) setStatus(st);
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ctx.client, reqId, live]);

  if (state.status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (state.status === 'error') return <Notice kind="error">{t.err_load_failed}</Notice>;
  if (!state.data) return null;
  const { kyc } = state.data;

  const token = async () => (await ctx.client.auth.getSession()).data.session?.access_token ?? '';

  const create = async () => {
    setError(null);
    setProblem(null);
    if (globalThis.navigator?.onLine === false) return setError('err_pay_offline');
    const thb = parsePriceInput(amount);
    if (thb === null || thb <= 0) return setProblem('below_minimum');
    const jwt = await token();
    if (!jwt) return setError('err_forbidden');
    try {
      const res = await fetch('/api/crypto/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ store_id: state.data!.storeId, customer_id: card.id, network, thb }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Req> & {
        error?: string;
        problem?: string;
      };
      if (!res.ok || !body.request_id) {
        if (res.status === 403) return setError('err_forbidden');
        return setProblem(body.problem ?? body.error ?? 'refused');
      }
      setReq(body as Req);
      setStatus('open');
    } catch {
      setError('err_pay_offline');
    }
  };

  const checkNow = async () => {
    if (!reqId) return;
    const jwt = await token();
    try {
      await fetch('/api/crypto/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ request_id: reqId }),
      });
      const { data } = await ctx.client
        .from('crypto_requests')
        .select('status')
        .eq('id', reqId)
        .maybeSingle();
      const st = (data as { status?: ReqStatus } | null)?.status;
      if (st) setStatus(st);
    } catch {
      setError('err_pay_offline');
    }
  };

  const cancel = async () => {
    if (!reqId) return;
    const { error: err } = await ctx.client.rpc('crypto_cancel_request', { p_request: reqId });
    if (err) return setError('err_save_failed');
    setStatus('cancelled');
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      /* copying is a convenience */
    }
  };

  const problemText = (p: string) =>
    (t as Record<string, string>)[`cryProblem_${p}`] ?? t.cryProblem_refused;

  return (
    <section className="card admin-card" aria-label={t.cryTitle}>
      <h3>{t.cryTitle}</h3>
      <p className="muted">{t.cryRule}</p>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}

      {!req ? (
        !kyc || kyc.status === 'rejected' ? (
          <KycForm ctx={ctx} card={card} storeId={state.data.storeId} onDone={state.reload} />
        ) : kyc.status === 'pending' ? (
          <Notice kind="info">{t.cryKycPending}</Notice>
        ) : canTake ? (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
            <p className="muted">{fmt(t.cryKycTier, { tier: kyc.tier })}</p>
            <div className="form-row">
              <label className="label" htmlFor="cry-net">
                {t.cryNetwork}
              </label>
              <select
                id="cry-net"
                className="field"
                value={network}
                onChange={(e) => isCryptoNetwork(e.target.value) && setNetwork(e.target.value)}
              >
                <option value="tron">{t.cryNet_tron}</option>
                <option value="ethereum">{t.cryNet_ethereum}</option>
              </select>
            </div>
            <div className="form-row">
              <label className="label" htmlFor="cry-thb">
                {t.cryAmount}
              </label>
              <input
                id="cry-thb"
                className="field tabular"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <p className="muted hint">{t.cryAmountHint}</p>
            </div>
            {problem ? <Notice kind="error">{problemText(problem)}</Notice> : null}
            <AsyncButton onClick={create}>{t.cryCreate}</AsyncButton>
          </form>
        ) : null
      ) : (
        <RequestCard
          req={req}
          status={status}
          left={Date.parse(req.expires_at) - now}
          money={(n) => formatTHB(n, locale)}
          copied={copied}
          onCopy={copy}
          onCheck={checkNow}
          onCancel={cancel}
          onNew={() => {
            setReq(null);
            setProblem(null);
            setAmount('');
          }}
        />
      )}
    </section>
  );
}

function RequestCard({
  req,
  status,
  left,
  money,
  copied,
  onCopy,
  onCheck,
  onCancel,
  onNew,
}: {
  req: Req;
  status: ReqStatus;
  left: number;
  money: (n: number) => string;
  copied: string | null;
  onCopy: (key: string, text: string) => Promise<void>;
  onCheck: () => Promise<void>;
  onCancel: () => Promise<void>;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const parts = addressParts(req.address);
  const done = status === 'credited';
  const live = status === 'open' || status === 'paid_pending';
  const label = (t as Record<string, string>)[`cryStatus_${status}`] ?? status;
  return (
    <div className="crypto-request">
      <h4>{fmt(t.cryRequestTitle, { thb: money(req.thb) })}</h4>
      <p className="crypto-status" role="status">
        {done ? fmt(t.cryDone, { thb: money(req.thb) }) : label}
      </p>
      {live ? (
        <>
          <p>{t.cryRequestSend}</p>
          <dl className="crypto-facts">
            <div>
              <dt>{t.cryRequestAmount}</dt>
              <dd className="crypto-big tabular">
                {req.units_text}{' '}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void onCopy('amount', req.units_text)}
                >
                  {copied === 'amount' ? t.cryRequestCopied : t.cryRequestCopy}
                </button>
              </dd>
            </div>
            <div>
              <dt>{t.cryRequestNetwork}</dt>
              <dd className="crypto-big">{req.token_label}</dd>
            </div>
            <div>
              <dt>{t.cryRequestAddress}</dt>
              <dd className="mono crypto-address">
                <strong className="crypto-end">{parts.head}</strong>
                {parts.middle}
                <strong className="crypto-end">{parts.tail}</strong>{' '}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void onCopy('address', req.address)}
                >
                  {copied === 'address' ? t.cryRequestCopied : t.cryRequestCopy}
                </button>
              </dd>
            </div>
          </dl>
          <p className="muted">{t.cryRequestCheck}</p>
          <QrSvg
            value={req.qr}
            label={fmt(t.cryRequestQrAlt, { amount: req.units_text, network: req.token_label })}
          />
          <p className="muted">{fmt(t.cryRequestRate, { rate: money(req.rate) })}</p>
          <p className={left > 0 ? 'muted' : 'notice notice-error'}>
            {left > 0 ? fmt(t.cryRequestLeft, { time: mmss(left) }) : t.cryRequestExpired}
          </p>
          <div className="actions">
            <AsyncButton variant="secondary" onClick={onCheck}>
              {t.cryCheckNow}
            </AsyncButton>
            {status === 'open' ? (
              <AsyncButton variant="secondary" onClick={onCancel}>
                {t.cryCancel}
              </AsyncButton>
            ) : null}
          </div>
        </>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={onNew}>
          {t.cryCreate}
        </button>
      )}
    </div>
  );
}

/** Passport-based identity check. T1 is the basic tier; T2 needs the source of funds and a wallet the customer proved is theirs. */
function KycForm({
  ctx,
  card,
  storeId,
  onDone,
}: {
  ctx: PageContext;
  card: CustomerCard;
  storeId: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(card.name);
  const [nationality, setNationality] = useState('');
  const [passport, setPassport] = useState('');
  const [contact, setContact] = useState(card.phone ?? '');
  const [t2, setT2] = useState(false);
  const [source, setSource] = useState('');
  const [address, setAddress] = useState('');
  const [net, setNet] = useState<CryptoNetwork>('tron');
  const [proof, setProof] = useState<'signed_message' | 'micro_transfer'>('signed_message');
  const [bad, setBad] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  const submit = async () => {
    setError(null);
    setBad(false);
    const addr = net === 'ethereum' ? address.trim().toLowerCase() : address.trim();
    if (
      name.trim().length < 2 ||
      nationality.trim().length < 2 ||
      !/^[A-Za-z0-9]{5,20}$/.test(passport.trim()) ||
      contact.trim().length < 3 ||
      (t2 && (source.trim().length === 0 || !cryptoAddressValid(net, addr)))
    )
      return setBad(true);
    const { error: err } = await ctx.client.rpc('crypto_kyc_submit', {
      p: {
        store_id: storeId,
        customer_id: card.id,
        tier: t2 ? 'T2' : 'T1',
        full_name: name.trim(),
        nationality: nationality.trim(),
        passport_no: passport.trim(),
        contact: contact.trim(),
        source_of_funds: t2 ? source.trim() : null,
        owned_addresses: t2 ? [{ network: net, address: addr, proof }] : [],
      },
    });
    if (err)
      return err.code === '23514' || err.code === '22023'
        ? setBad(true)
        : setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    onDone();
  };

  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <h4>{t.cryKycTitle}</h4>
      <p className="muted">{t.cryKycNeeded}</p>
      <div className="filters">
        <div className="form-row">
          <label className="label" htmlFor="kyc-name">
            {t.cryKycName}
          </label>
          <input
            id="kyc-name"
            className="field"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="kyc-nat">
            {t.cryKycNationality}
          </label>
          <input
            id="kyc-nat"
            className="field"
            value={nationality}
            maxLength={60}
            onChange={(e) => setNationality(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="kyc-pass">
            {t.cryKycPassport}
          </label>
          <input
            id="kyc-pass"
            className="field mono"
            autoComplete="off"
            value={passport}
            maxLength={20}
            onChange={(e) => setPassport(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="kyc-contact">
            {t.cryKycContact}
          </label>
          <input
            id="kyc-contact"
            className="field"
            value={contact}
            maxLength={120}
            onChange={(e) => setContact(e.target.value)}
          />
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={t2} onChange={(e) => setT2(e.target.checked)} />
        <span>{t.cryKycT2}</span>
      </label>
      {t2 ? (
        <div className="filters">
          <div className="form-row">
            <label className="label" htmlFor="kyc-src">
              {t.cryKycSource}
            </label>
            <input
              id="kyc-src"
              className="field"
              value={source}
              maxLength={500}
              onChange={(e) => setSource(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kyc-net">
              {t.cryKycNetwork}
            </label>
            <select
              id="kyc-net"
              className="field"
              value={net}
              onChange={(e) => isCryptoNetwork(e.target.value) && setNet(e.target.value)}
            >
              <option value="tron">{CRYPTO_NETWORKS.tron.tokenLabel}</option>
              <option value="ethereum">{CRYPTO_NETWORKS.ethereum.tokenLabel}</option>
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kyc-addr">
              {t.cryKycAddress}
            </label>
            <input
              id="kyc-addr"
              className="field mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="kyc-proof">
              {t.cryKycProof}
            </label>
            <select
              id="kyc-proof"
              className="field"
              value={proof}
              onChange={(e) =>
                setProof(e.target.value === 'micro_transfer' ? 'micro_transfer' : 'signed_message')
              }
            >
              <option value="signed_message">{t.cryKycProof_signed_message}</option>
              <option value="micro_transfer">{t.cryKycProof_micro_transfer}</option>
            </select>
          </div>
        </div>
      ) : null}
      {bad ? <Notice kind="error">{t.cryKycBad}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <AsyncButton onClick={submit}>{t.cryKycSubmit}</AsyncButton>
    </form>
  );
}
