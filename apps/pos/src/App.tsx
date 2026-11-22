import { useCallback, useMemo, useState } from 'react';
import { AuthApp, useAuth } from '@bestie/auth';
import type { ActingIdentity, DeviceMode } from '@bestie/auth';
import { guestHubPages } from '@bestie/guest-ui';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { SyncIndicator, useDeviceBinding, useOutboxSync } from '@bestie/offline';
import { loadActing, saveActing, useIdleLock } from './acting';
import { LockScreen } from './LockScreen';
import { posPages } from './posPages';

/** Sync status + lock button in the top bar (needs the signed-in client, so it lives inside the auth provider). */
function DeviceBar({ tillMode, onLock }: { tillMode: boolean; onLock: () => void }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const sync = useOutboxSync(client);
  return (
    <>
      <SyncIndicator
        state={sync.state}
        pending={sync.pending}
        dead={sync.dead}
        onSyncNow={sync.syncNow}
      />
      {tillMode ? (
        <AsyncButton variant="secondary" onClick={onLock}>
          {t.lockButton}
        </AsyncButton>
      ) : null}
    </>
  );
}

// Public build-time config only (VITE_ prefix). See docs/ENVIRONMENT.md.
export function App() {
  const binding = useDeviceBinding();
  const [acting, setActing] = useState<ActingIdentity | null>(() => loadActing());
  // "nobody has a PIN yet": the account may work (and go set PINs) until someone does
  const [setupMode, setSetupMode] = useState(false);

  const lock = useCallback(() => {
    saveActing(null);
    setActing(null);
    setSetupMode(false);
  }, []);
  useIdleLock(binding !== null && acting !== null, lock);

  const deviceMode = useMemo<DeviceMode>(
    () => ({
      acting,
      headerExtra: <DeviceBar tillMode={binding !== null} onLock={lock} />,
      gate: (ctx, effective) => {
        if (!binding) return null; // not a till (an owner at a desk): normal back-office behaviour
        if (effective || setupMode) return null;
        // /account and the back-office pages stay behind the PIN too: whoever holds the till must identify themselves
        return (
          <LockScreen
            ctx={ctx}
            binding={binding}
            onUnlock={(a) => {
              if (a === 'open') return setSetupMode(true);
              saveActing(a);
              setActing(a);
            }}
          />
        );
      },
    }),
    [acting, binding, lock, setupMode],
  );

  return (
    <AuthApp
      app="pos"
      rawEnv={import.meta.env}
      pages={posPages}
      guestPages={guestHubPages}
      deviceMode={deviceMode}
    />
  );
}
