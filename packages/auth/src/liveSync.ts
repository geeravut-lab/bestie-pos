/**
 * Live sync scheduling (docs/LIVE-SYNC-KNOWLEDGE.md) — pure, no React, no Supabase, so it is fully unit-tested.
 *
 *  - a `ping` (content-free signal from the database) → refresh once, debounced;
 *  - never refresh "under the user's hands": busy (typing / open dialog) → try again shortly;
 *  - hidden tab → pause, remember that something changed, catch up when it becomes visible;
 *  - socket down → poll with a slowing backoff; socket (re)connected → one catch-up refresh;
 *  - a refresh that throws never kills the loop.
 */
export type LiveSyncOptions = {
  refresh: () => void | Promise<void>;
  isBusy?: () => boolean;
  debounceMs?: number;
  busyRetryMs?: number;
  /** Poll intervals while the socket is down; the last one repeats. */
  pollMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
};

export class LiveSyncController {
  private readonly o: Required<Omit<LiveSyncOptions, 'isBusy'>> & { isBusy: () => boolean };
  private debounce: unknown = null;
  private poll: unknown = null;
  private pollStep = 0;
  private visible = true;
  private connected = false;
  private everConnected = false;
  private pending = false;
  private disposed = false;

  constructor(options: LiveSyncOptions) {
    this.o = {
      refresh: options.refresh,
      isBusy: options.isBusy ?? (() => false),
      debounceMs: options.debounceMs ?? 300,
      busyRetryMs: options.busyRetryMs ?? 2000,
      pollMs: options.pollMs ?? [15_000, 30_000, 60_000],
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    };
    this.schedulePoll(); // starts disconnected: poll until the socket reports in
  }

  /** The database says "something changed". */
  ping(): void {
    this.pending = true;
    this.pollStep = 0;
    this.schedule(this.o.debounceMs);
  }

  setConnected(connected: boolean): void {
    if (this.disposed || connected === this.connected) return;
    this.connected = connected;
    if (connected) {
      this.cancelPoll();
      if (this.everConnected) {
        this.pending = true; // we may have missed pings while the socket was down
        this.schedule(0);
      }
      this.everConnected = true;
    } else {
      this.pollStep = 0;
      this.schedulePoll();
    }
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (visible && this.pending) this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounce !== null) this.o.clearTimer(this.debounce);
    this.cancelPoll();
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    if (this.debounce !== null) this.o.clearTimer(this.debounce);
    this.debounce = this.o.setTimer(() => {
      this.debounce = null;
      this.run();
    }, ms);
  }

  private run(): void {
    if (this.disposed || !this.pending) return;
    if (!this.visible) return; // hidden tab: stay pending, setVisible(true) will catch up
    if (this.o.isBusy()) {
      this.schedule(this.o.busyRetryMs); // never refresh under the user's hands
      return;
    }
    this.pending = false;
    try {
      void Promise.resolve(this.o.refresh()).catch(() => {});
    } catch {
      /* a failing refresh must not stop the loop */
    }
  }

  private schedulePoll(): void {
    if (this.disposed || this.connected || this.poll !== null) return;
    const ms = this.o.pollMs[Math.min(this.pollStep, this.o.pollMs.length - 1)]!;
    this.poll = this.o.setTimer(() => {
      this.poll = null;
      if (this.connected || this.disposed) return;
      this.pollStep += 1;
      if (this.visible) {
        this.pending = true;
        this.schedule(0);
      }
      this.schedulePoll();
    }, ms);
  }

  private cancelPoll(): void {
    if (this.poll !== null) this.o.clearTimer(this.poll);
    this.poll = null;
  }
}

/** True while someone is typing or a dialog is open: a refresh now would pull the rug from under them. */
export function isUserBusy(doc: Document = document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
    if (tag === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      if (!['checkbox', 'radio', 'button', 'submit', 'range'].includes(type)) return true;
    }
  }
  return doc.querySelector('[role="dialog"][aria-modal="true"], [data-live-busy]') !== null;
}
