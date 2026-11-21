import { describe, expect, it } from 'vitest';
import { healthFlags, healthIntakePayload, parseHealthAnswers } from './clientRecords';

describe('parseHealthAnswers', () => {
  it('keeps only the closed set with the right types', () => {
    expect(
      parseHealthAnswers({
        pregnant: true,
        heart: 'yes',
        allergies: ' nuts ',
        secret: 'x',
        other: '  ',
      }),
    ).toEqual({ pregnant: true, allergies: 'nuts' });
    expect(parseHealthAnswers(null)).toEqual({});
    expect(parseHealthAnswers([1])).toEqual({});
  });
  it('cuts free text at 300 characters', () => {
    expect(parseHealthAnswers({ other: 'x'.repeat(400) }).other?.length).toBe(300);
  });
});

describe('healthFlags', () => {
  it('lists the yes answers and the filled text fields', () => {
    expect(healthFlags({ pregnant: true, heart: false, allergies: 'nuts' })).toEqual({
      yes: ['pregnant'],
      text: ['allergies'],
    });
  });
});

describe('healthIntakePayload', () => {
  const base = {
    storeId: 's',
    customerId: 'c',
    answers: { high_bp: false },
    consent: true,
    signedName: ' Mali Sue ',
  };
  it('needs consent and a real name', () => {
    expect(healthIntakePayload({ ...base, consent: false })).toBeNull();
    expect(healthIntakePayload({ ...base, signedName: 'M' })).toBeNull();
  });
  it('keeps a "no" answer (false) and trims the signature', () => {
    expect(healthIntakePayload(base)).toEqual({
      store_id: 's',
      customer_id: 'c',
      answers: { high_bp: false },
      consent: true,
      signed_name: 'Mali Sue',
    });
  });
});
