import type { SyncState } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';

/** A small pill in the top bar: online / offline, how many writes wait, and a button to retry now. */
export function SyncIndicator({
  state,
  pending,
  dead,
  onSyncNow,
}: {
  state: SyncState;
  pending: number;
  dead: number;
  onSyncNow?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const label =
    state === 'offline'
      ? pending > 0
        ? fmt(t.syncOfflineQueued, { n: pending })
        : t.syncOffline
      : state === 'attention'
        ? fmt(t.syncAttention, { n: dead })
        : state === 'syncing'
          ? t.syncSyncing
          : state === 'queued'
            ? fmt(t.syncQueued, { n: pending })
            : t.syncSynced;
  return (
    <span className="sync-pill" data-state={state} role="status" aria-live="polite">
      <span className="sync-dot" aria-hidden="true" />
      <span>{label}</span>
      {onSyncNow && (state === 'queued' || state === 'attention') ? (
        <AsyncButton variant="secondary" className="sync-retry" onClick={onSyncNow}>
          {t.syncNow}
        </AsyncButton>
      ) : null}
    </span>
  );
}
