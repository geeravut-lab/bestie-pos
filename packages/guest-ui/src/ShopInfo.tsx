import { useEffect, useState } from 'react';
import { FEEDBACK_TOPICS, guestName } from '@bestie/core';
import type { InfoCard } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { askInfo, loadInfoCards, sendFeedback } from './guestApi';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/**
 * The shop's own information cards (wifi, opening hours, check-out, tips). Always shown as a plain list. When the shop switched the
 * assistant on, the guest can also type a question: the assistant only POINTS at cards the shop wrote — what is shown is the shop's own
 * text. When nothing fits, the page says so and points to the "Call the staff" button.
 */
export function ShopInfo({ token, ai }: { token: string; ai: boolean }) {
  const { t, lang } = useI18n();
  const [cards, setCards] = useState<InfoCard[] | null>(null);
  const [text, setText] = useState('');
  const [found, setFound] = useState<InfoCard[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadInfoCards(token).then((c) => alive && setCards(c));
    return () => {
      alive = false;
    };
  }, [token]);
  if (!cards || cards.length === 0) return null;

  const ask = async () => {
    setFound(null);
    const r = await askInfo(token, text.trim());
    setFound(r ?? []);
    if (r && r.length > 0) setOpen(r[0]!.id);
  };
  const shown = found && found.length > 0 ? found : cards;

  return (
    <section className="guest-info" aria-label={t.gsInfoTitle}>
      <h2>{t.gsInfoTitle}</h2>
      {ai ? (
        <div className="form-row">
          <label className="label" htmlFor="gs-info-q">
            {t.gsInfoAskLabel}
          </label>
          <input
            id="gs-info-q"
            className="field"
            maxLength={300}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <AsyncButton variant="secondary" disabled={text.trim().length < 2} onClick={ask}>
            {t.gsInfoAskSend}
          </AsyncButton>
        </div>
      ) : null}
      {found && found.length === 0 ? <p className="muted">{t.gsInfoNone}</p> : null}
      <ul className="guest-info-list">
        {shown.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="chip"
              aria-expanded={open === c.id}
              onClick={() => setOpen(open === c.id ? null : c.id)}
            >
              {guestName(c.title, lang)}
            </button>
            {open === c.id ? (
              <p style={{ whiteSpace: 'pre-wrap' }}>{guestName(c.body, lang)}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A short feedback form: stars, a topic, an optional comment. No name, no contact details. */
export function FeedbackForm({ token }: { token: string }) {
  const { t } = useI18n();
  const [rating, setRating] = useState(0);
  const [topic, setTopic] = useState<string>('other');
  const [comment, setComment] = useState('');
  const [note, setNote] = useState<'sent' | 'too_many' | 'failed' | null>(null);

  if (note === 'sent')
    return (
      <p className="notice notice-success" role="status">
        {t.gsFbThanks}
      </p>
    );
  return (
    <section className="guest-feedback" aria-label={t.gsFbTitle}>
      <h2>{t.gsFbTitle}</h2>
      <div className="chips" role="group" aria-label={t.gsFbRating}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className="chip"
            aria-pressed={rating === n}
            aria-label={`${n} / 5`}
            onClick={() => setRating(n)}
          >
            {'★'.repeat(n)}
          </button>
        ))}
      </div>
      <div className="form-row">
        <label className="label" htmlFor="gs-fb-topic">
          {t.gsFbTopic}
        </label>
        <select
          id="gs-fb-topic"
          className="field"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        >
          {FEEDBACK_TOPICS.map((k) => (
            <option key={k} value={k}>
              {tx(t, `gsFbTopic_${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label className="label" htmlFor="gs-fb-comment">
          {t.gsFbComment}
        </label>
        <textarea
          id="gs-fb-comment"
          className="field"
          rows={3}
          maxLength={500}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      <AsyncButton
        disabled={rating === 0}
        onClick={async () => setNote(await sendFeedback(token, { rating, topic, comment }))}
      >
        {t.gsFbSend}
      </AsyncButton>
      {note === 'too_many' || note === 'failed' ? (
        <p className="notice notice-error" role="alert">
          {note === 'too_many' ? t.gsFbTooMany : t.gsFbFailed}
        </p>
      ) : null}
    </section>
  );
}
