import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSyncController, isUserBusy } from './liveSync';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const make = (over: Partial<ConstructorParameters<typeof LiveSyncController>[0]> = {}) => {
  const refresh = vi.fn();
  const c = new LiveSyncController({ refresh, ...over });
  return { c, refresh };
};

describe('LiveSyncController', () => {
  it('refreshes once after a burst of pings (debounced)', () => {
    const { c, refresh } = make();
    c.setConnected(true);
    c.ping();
    c.ping();
    c.ping();
    vi.advanceTimersByTime(299);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never refreshes under the user's hands: busy → retry later", () => {
    let busy = true;
    const { c, refresh } = make({ isBusy: () => busy });
    c.setConnected(true);
    c.ping();
    vi.advanceTimersByTime(300);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(refresh).not.toHaveBeenCalled(); // still busy
    busy = false;
    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab pauses and catches up exactly once when it becomes visible', () => {
    const { c, refresh } = make();
    c.setConnected(true);
    c.setVisible(false);
    c.ping();
    c.ping();
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
    c.setVisible(true);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('becoming visible with nothing missed does not refresh', () => {
    const { c, refresh } = make();
    c.setConnected(true);
    c.setVisible(false);
    c.setVisible(true);
    vi.advanceTimersByTime(1000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('polls with a slowing backoff while the socket is down, and stops once connected', () => {
    const { c, refresh } = make({ pollMs: [1000, 2000, 4000] });
    // (a timer scheduled from inside a timer callback is clamped to ≥ 1 ms, hence the +1)
    vi.advanceTimersByTime(1001);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4000);
    expect(refresh).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(4000); // capped at the last interval
    expect(refresh).toHaveBeenCalledTimes(4);
    c.setConnected(true); // first connection: nothing was missed, no extra refresh
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('a reconnect after an outage triggers one catch-up refresh and polling resumes on the next outage', () => {
    const { c, refresh } = make({ pollMs: [1000] });
    c.setConnected(true);
    c.setConnected(false);
    vi.advanceTimersByTime(1001);
    expect(refresh).toHaveBeenCalledTimes(1); // poll
    c.setConnected(true);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2); // catch-up
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(2); // quiet while connected
  });

  it('survives a refresh that throws or rejects', async () => {
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockRejectedValueOnce(new Error('nope'));
    const c = new LiveSyncController({ refresh });
    c.setConnected(true);
    c.ping();
    vi.advanceTimersByTime(300);
    c.ping();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('dispose stops everything', () => {
    const { c, refresh } = make();
    c.ping();
    c.dispose();
    vi.advanceTimersByTime(120_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('isUserBusy', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  it('is busy while typing in a field, not while a button is focused', () => {
    document.body.innerHTML =
      '<input id="t" type="text"><button id="b">x</button><input id="c" type="checkbox">';
    (document.getElementById('t') as HTMLInputElement).focus();
    expect(isUserBusy()).toBe(true);
    (document.getElementById('b') as HTMLButtonElement).focus();
    expect(isUserBusy()).toBe(false);
    (document.getElementById('c') as HTMLInputElement).focus();
    expect(isUserBusy()).toBe(false);
  });
  it('is busy while a modal dialog or a marked form is open', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(isUserBusy()).toBe(true);
    document.body.innerHTML = '<form data-live-busy></form>';
    expect(isUserBusy()).toBe(true);
  });
});
