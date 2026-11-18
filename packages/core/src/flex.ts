/**
 * LINE Flex message for a notice (docs/LINE-FLEX-CARD-KNOWLEDGE.md), pure and unit-tested.
 *
 * One bubble per message: title → ≤ 8 detail lines (summary + "label: value" rows) → one button that opens the app.
 *  - the message is stored as plain text (summary + `label: value` lines); the card is built from it when sending;
 *  - EVERY field is truncated with "…" (LINE rejects over-long fields); `altText` carries the whole story because that is
 *    what shows on the lock screen / chat list, not the card;
 *  - the button opens in the phone's browser (`openExternalBrowser=1`), never LIFF, and only to a path INSIDE our site;
 *  - colours are the Bestie tokens (a Flex JSON cannot reference CSS variables; a test keeps them equal to theme.css).
 *    The button is teal with white text (white on coral would fail contrast).
 */
export const FLEX_LIMITS = {
  title: 100,
  text: 300,
  label: 24,
  value: 120,
  button: 20,
  altText: 400,
  lines: 8,
} as const;

/** Hex values mirrored from packages/ui/src/theme.css (--bp-primary-hover / ink / muted / primary). */
export const FLEX_COLORS = {
  title: '#005f58',
  text: '#0f2d4a',
  label: '#4f6577',
  button: '#00796f',
} as const;

export type NoticeLine = { label: string; value: string };
export type Notice = { title: string; summary?: string; lines?: readonly NoticeLine[] };

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const chars = [...t]; // by code point, so Thai and emoji are never cut in half
  return chars.length <= max
    ? t
    : chars
        .slice(0, Math.max(0, max - 1))
        .join('')
        .trimEnd() + '…';
}

/** `summary` then one `label: value` per line — the single plain-text form that is stored. */
export function noticeBody(summary: string | undefined, lines: readonly NoticeLine[] = []): string {
  return [summary?.trim(), ...lines.map((l) => `${l.label.trim()}: ${l.value.trim()}`)]
    .filter((x): x is string => Boolean(x))
    .join('\n');
}

const LABEL_VALUE = /^([^:：\n]{1,40})[:：]\s+(.+)$/;

/** Inverse of `noticeBody`: lines shaped `label: value` become rows, anything else is summary text. */
export function parseNotice(title: string, body: string): Notice {
  const summary: string[] = [];
  const lines: NoticeLine[] = [];
  for (const raw of body.split('\n')) {
    const row = raw.trim();
    if (!row) continue;
    const m = LABEL_VALUE.exec(row);
    if (m && !/^https?$/i.test(m[1]!.trim()))
      lines.push({ label: m[1]!.trim(), value: m[2]!.trim() });
    else summary.push(row);
  }
  return { title, ...(summary.length ? { summary: summary.join(' ') } : {}), lines };
}

/** Only a path inside our own site; anything else (other hosts, `//x`, `javascript:`, empty) falls back to the home page. */
export function safeInternalPath(path: unknown): string {
  if (typeof path !== 'string') return '/';
  const p = path.trim();
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return '/';
  if ([...p].some((c) => c.codePointAt(0)! < 0x20)) return '/'; // control characters
  return p;
}

export function appLink(siteUrl: string, path: unknown): string {
  const p = safeInternalPath(path);
  return `${siteUrl.replace(/\/+$/, '')}${p}${p.includes('?') ? '&' : '?'}openExternalBrowser=1`;
}

export type FlexMessage = { type: 'flex'; altText: string; contents: Record<string, unknown> };

export function buildFlexMessage(args: {
  notice: Notice;
  openLabel: string;
  siteUrl: string;
  path?: string;
}): FlexMessage {
  const { notice, openLabel, siteUrl, path } = args;
  const title = truncate(notice.title, FLEX_LIMITS.title);
  const summary = notice.summary ? truncate(notice.summary, FLEX_LIMITS.text) : '';
  const rows = (notice.lines ?? []).slice(0, FLEX_LIMITS.lines - (summary ? 1 : 0)).map((l) => ({
    label: truncate(l.label, FLEX_LIMITS.label),
    value: truncate(l.value, FLEX_LIMITS.value),
  }));

  const body: Record<string, unknown>[] = [
    { type: 'text', text: title, weight: 'bold', size: 'md', color: FLEX_COLORS.title, wrap: true },
  ];
  if (summary)
    body.push({ type: 'text', text: summary, size: 'sm', color: FLEX_COLORS.text, wrap: true });
  for (const r of rows) {
    body.push({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: r.label, size: 'sm', color: FLEX_COLORS.label, flex: 2, wrap: true },
        { type: 'text', text: r.value, size: 'sm', color: FLEX_COLORS.text, flex: 4, wrap: true },
      ],
    });
  }

  const altText = truncate(
    [title, summary, ...rows.map((r) => `${r.label} ${r.value}`)]
      .filter(Boolean)
      .join(' — ')
      .replace(/ — /g, ' — '),
    FLEX_LIMITS.altText,
  );
  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: FLEX_COLORS.button,
            action: {
              type: 'uri',
              label: truncate(openLabel, FLEX_LIMITS.button),
              uri: appLink(siteUrl, path),
            },
          },
        ],
      },
    },
  };
}

// ── account linking ────────────────────────────────────────────────────────
/** No 0 / O / 1 / I: people read the code off a screen and type it into a chat. */
export const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 8;
export const LINK_CODE_TTL_MINUTES = 30;
export const LINK_MAX_ATTEMPTS = 5;
const CODE_BODY = `[${LINK_ALPHABET}]`;

/** 8 characters from the alphabet; `byte & 31` is unbiased because the alphabet has exactly 32 symbols. */
export function linkCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < LINK_CODE_LENGTH) throw new Error('need at least 8 random bytes');
  let out = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += LINK_ALPHABET[bytes[i]! & 31];
  return out;
}

/** `ABCD2345` or `link abcd2345` (any case, surrounding space) → the code; anything else → null. */
export function parseLinkMessage(text: string): string | null {
  const m = new RegExp(`^(?:LINK\\s+)?(${CODE_BODY}{${LINK_CODE_LENGTH}})$`).exec(
    text.trim().toUpperCase(),
  );
  return m?.[1] ?? null;
}
