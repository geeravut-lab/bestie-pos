import { beforeEach, describe, expect, it } from 'vitest';
import { forgetPin, rememberPin, resetOfflineDb, verifyPinLocally, db } from './index';

beforeEach(async () => {
  await resetOfflineDb();
});

describe('offline PIN check', () => {
  it('knows nothing about someone the server never accepted on this tablet', async () => {
    expect(await verifyPinLocally('s1', '4821')).toBe('unknown');
  });

  it('accepts the remembered PIN and rejects another', async () => {
    await rememberPin('s1', '4821');
    expect(await verifyPinLocally('s1', '4821')).toBe('ok');
    expect(await verifyPinLocally('s1', '0000')).toBe('wrong');
  });

  it('never stores the PIN itself, and each person has their own salt', async () => {
    await rememberPin('s1', '4821');
    await rememberPin('s2', '4821');
    const rows = JSON.stringify(await db.kv.toArray());
    expect(rows).not.toContain('4821');
    const [a, b] = (await db.kv.toArray()).map((r) => r.value as { salt: string; hash: string });
    expect(a!.salt).not.toBe(b!.salt);
    expect(a!.hash).not.toBe(b!.hash);
  });

  it('locks for 15 minutes after 5 wrong tries — even the right PIN is refused — then allows again', async () => {
    await rememberPin('s1', '4821');
    let now = 1_000_000;
    for (let i = 0; i < 4; i++)
      expect(await verifyPinLocally('s1', '0000', () => now)).toBe('wrong');
    expect(await verifyPinLocally('s1', '0000', () => now)).toBe('locked');
    expect(await verifyPinLocally('s1', '4821', () => now)).toBe('locked');
    now += 15 * 60_000 + 1;
    expect(await verifyPinLocally('s1', '4821', () => now)).toBe('ok');
  });

  it('a right PIN resets the wrong-try counter', async () => {
    await rememberPin('s1', '4821');
    for (let i = 0; i < 3; i++) await verifyPinLocally('s1', '0000');
    expect(await verifyPinLocally('s1', '4821')).toBe('ok');
    for (let i = 0; i < 4; i++) expect(await verifyPinLocally('s1', '0000')).toBe('wrong');
  });

  it('a changed PIN replaces the old verifier; forgetting removes it', async () => {
    await rememberPin('s1', '4821');
    await rememberPin('s1', '7777');
    expect(await verifyPinLocally('s1', '4821')).toBe('wrong');
    expect(await verifyPinLocally('s1', '7777')).toBe('ok');
    await forgetPin('s1');
    expect(await verifyPinLocally('s1', '7777')).toBe('unknown');
  });

  it('refuses to remember something that is not a valid PIN', async () => {
    await rememberPin('s1', 'abcd');
    expect(await verifyPinLocally('s1', 'abcd')).toBe('unknown');
  });
});
