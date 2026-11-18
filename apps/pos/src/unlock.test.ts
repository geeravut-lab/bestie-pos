import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOfflineDb } from '@bestie/offline';
import { unlockWithPin } from './unlock';
import type { PinClient } from './unlock';

beforeEach(async () => {
  await resetOfflineDb();
});

const server = (answer: string | Error): PinClient => ({
  rpc: vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { data: answer, error: null };
  }),
});

describe('unlockWithPin', () => {
  it('online: the server decides, and a PIN it accepts is remembered for offline use', async () => {
    expect(await unlockWithPin(server('ok'), 's1', '4821', true)).toBe('ok');
    const offline = server(new TypeError('Failed to fetch'));
    expect(await unlockWithPin(offline, 's1', '4821', false)).toBe('ok');
    expect(await unlockWithPin(offline, 's1', '0000', false)).toBe('wrong');
  });

  it("online: a wrong / locked / missing PIN is the server's final word (no sneaking in via the local copy)", async () => {
    await unlockWithPin(server('ok'), 's1', '4821', true); // the tablet remembers 4821
    expect(await unlockWithPin(server('wrong'), 's1', '4821', true)).toBe('wrong');
    expect(await unlockWithPin(server('locked'), 's1', '4821', true)).toBe('locked');
    expect(await unlockWithPin(server('no_pin'), 's1', '4821', true)).toBe('no_pin');
  });

  it('the request fails although the browser says online: the tablet falls back to its own check', async () => {
    await unlockWithPin(server('ok'), 's1', '4821', true);
    expect(await unlockWithPin(server(new Error('boom')), 's1', '4821', true)).toBe('ok');
  });

  it('offline and never confirmed on this tablet: asks the person to connect once', async () => {
    expect(await unlockWithPin(server(new Error('x')), 'stranger', '4821', false)).toBe(
      'unknown_offline',
    );
  });

  it('offline: five wrong tries lock the person on this tablet', async () => {
    await unlockWithPin(server('ok'), 's1', '4821', true);
    const off = server(new Error('x'));
    for (let i = 0; i < 4; i++) expect(await unlockWithPin(off, 's1', '0000', false)).toBe('wrong');
    expect(await unlockWithPin(off, 's1', '0000', false)).toBe('locked');
    expect(await unlockWithPin(off, 's1', '4821', false)).toBe('locked');
  });
});
