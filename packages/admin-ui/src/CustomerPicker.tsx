import { useState } from 'react';
import { normalizePhone, parseCustomerCard, parseCustomerCards, searchWorthy } from '@bestie/core';
import type { CustomerCard } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

/** Find a member by phone / member code / name, or add a new one. Online only (the member list is not kept on the tablet). */
export function CustomerPicker({
  ctx,
  onPick,
  idPrefix = 'cust',
}: {
  ctx: PageContext;
  onPick: (c: CustomerCard) => void;
  idPrefix?: string;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<CustomerCard[] | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [note, setNote] = useState<'duplicate' | 'bad' | null>(null);

  const search = async () => {
    setError(null);
    if (!searchWorthy(q)) return setFound([]);
    const { data, error: err } = await ctx.client.rpc('find_customers', {
      p_org: ctx.orgId,
      p_query: q.trim(),
    });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_load_failed');
    setFound(parseCustomerCards(data));
  };

  const create = async () => {
    setError(null);
    setNote(null);
    const digits = normalizePhone(phone);
    if (name.trim().length < 1 || (digits !== '' && (digits.length < 8 || digits.length > 15)))
      return setNote('bad');
    const { data, error: err } = await ctx.client.rpc('create_customer', {
      p: { org_id: ctx.orgId, name: name.trim(), phone: digits || null, consent },
    });
    if (err) {
      if (err.code === '23505') return setNote('duplicate');
      if (err.code === '22023') return setNote('bad');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    const card = parseCustomerCard(data);
    if (!card) return setError('err_save_failed');
    setName('');
    setPhone('');
    setAdding(false);
    onPick(card);
  };

  return (
    <div className="customer-picker">
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <div className="form-row">
          <label className="label" htmlFor={`${idPrefix}-q`}>
            {t.custSearchLabel}
          </label>
          <input
            id={`${idPrefix}-q`}
            className="field"
            value={q}
            placeholder={t.custSearchHint}
            maxLength={60}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <AsyncButton onClick={search}>{t.custSearch}</AsyncButton>
      </form>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {found && found.length === 0 ? <p className="muted">{t.custNone}</p> : null}
      <ul className="member-list">
        {(found ?? []).map((c) => (
          <li key={c.id} className="member-row">
            <button
              type="button"
              className="order-row"
              aria-label={fmt(t.custPick, { name: c.name })}
              onClick={() => onPick(c)}
            >
              <strong>{c.name}</strong>
              <span className="muted tabular">{c.phone ?? ''}</span>
              <span className="muted tabular">{fmt(t.custPoints, { n: c.points })}</span>
            </button>
          </li>
        ))}
      </ul>
      {!adding ? (
        <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>
          {t.custNew}
        </button>
      ) : (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-row">
            <label className="label" htmlFor={`${idPrefix}-name`}>
              {t.custName}
            </label>
            <input
              id={`${idPrefix}-name`}
              className="field"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor={`${idPrefix}-phone`}>
              {t.custPhone}
            </label>
            <input
              id={`${idPrefix}-phone`}
              className="field"
              inputMode="tel"
              value={phone}
              maxLength={24}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>{t.custConsent}</span>
          </label>
          {note ? (
            <Notice kind="error">{note === 'duplicate' ? t.custDuplicate : t.custBadInput}</Notice>
          ) : null}
          <AsyncButton onClick={create}>{t.custCreate}</AsyncButton>
        </form>
      )}
    </div>
  );
}
