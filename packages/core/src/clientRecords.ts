// Client records (salon / spa): the closed health questionnaire and what a screen needs to read it back safely.

export const HEALTH_YES_NO = ['pregnant', 'high_bp', 'heart', 'diabetes', 'skin'] as const;
export const HEALTH_TEXT = ['allergies', 'injuries', 'medications', 'other'] as const;
export type HealthYesNo = (typeof HEALTH_YES_NO)[number];
export type HealthText = (typeof HEALTH_TEXT)[number];
export const HEALTH_TEXT_MAX = 300;

export type HealthAnswers = Partial<Record<HealthYesNo, boolean>> &
  Partial<Record<HealthText, string>>;

/** Reads the stored answers; anything outside the closed set (or of the wrong type) is dropped. */
export function parseHealthAnswers(raw: unknown): HealthAnswers {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: HealthAnswers = {};
  for (const k of HEALTH_YES_NO) if (typeof o[k] === 'boolean') out[k] = o[k];
  for (const k of HEALTH_TEXT)
    if (typeof o[k] === 'string' && o[k].trim() !== '')
      out[k] = o[k].trim().slice(0, HEALTH_TEXT_MAX);
  return out;
}

/** What the therapist should notice first: the yes / no questions answered "yes" and any free text. */
export function healthFlags(a: HealthAnswers): { yes: HealthYesNo[]; text: HealthText[] } {
  return {
    yes: HEALTH_YES_NO.filter((k) => a[k] === true),
    text: HEALTH_TEXT.filter((k) => (a[k] ?? '') !== ''),
  };
}

/** The body of `save_health_intake`; null while the form is not complete (no consent, no signature, too-long text). */
export function healthIntakePayload(input: {
  storeId: string;
  customerId: string;
  answers: HealthAnswers;
  consent: boolean;
  signedName: string;
}): Record<string, unknown> | null {
  const name = input.signedName.trim();
  if (!input.consent || name.length < 2 || name.length > 80) return null;
  const answers = parseHealthAnswers(input.answers);
  for (const k of HEALTH_YES_NO)
    if (typeof input.answers[k] === 'boolean') answers[k] = input.answers[k];
  return {
    store_id: input.storeId,
    customer_id: input.customerId,
    answers,
    consent: true,
    signed_name: name,
  };
}
