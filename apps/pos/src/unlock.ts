import { rememberPin, verifyPinLocally } from '@bestie/offline';

/** The one call this needs from the Supabase client (kept structural so tests can fake it). */
export type PinClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type UnlockResult = 'ok' | 'wrong' | 'locked' | 'no_pin' | 'unknown_offline';

/**
 * The server is the judge when it can be reached (and then this tablet remembers a salted verifier of the accepted PIN).
 * With no signal the tablet's own verifier decides — but only for someone whose PIN the server accepted here before.
 */
export async function unlockWithPin(
  client: PinClient,
  staffId: string,
  pin: string,
  online: boolean,
): Promise<UnlockResult> {
  if (online) {
    try {
      const { data, error } = await client.rpc('verify_staff_pin', {
        p_staff: staffId,
        p_pin: pin,
      });
      if (!error && typeof data === 'string') {
        if (data === 'ok') {
          await rememberPin(staffId, pin);
          return 'ok';
        }
        if (data === 'wrong' || data === 'locked' || data === 'no_pin') return data;
      }
    } catch {
      /* the request failed: use the tablet's own check below */
    }
  }
  const local = await verifyPinLocally(staffId, pin);
  return local === 'unknown' ? 'unknown_offline' : local;
}
