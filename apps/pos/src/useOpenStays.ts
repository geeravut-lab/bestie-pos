import { useEffect, useState } from 'react';
import { parseFolioRooms, parseStays, stayLabel } from '@bestie/core';
import type { PageContext } from '@bestie/auth';

/**
 * The guests in the house a bill may be charged to (module `folio`): read when the payment sheet opens. Any member of the business may read the open stays;
 * offline or without a folio the list is empty and the Room tab does not appear.
 */
export function useOpenStays(ctx: PageContext, active: boolean): { id: string; label: string }[] {
  const [stays, setStays] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void (async () => {
      try {
        const [s, r] = await Promise.all([
          ctx.client
            .from('folios')
            .select(
              'id, room_id, guest_name, phone, check_in_at, check_out_on, note, status, closed_at',
            )
            .eq('status', 'open')
            .order('check_in_at'),
          ctx.client.from('folio_rooms').select('id, store_id, name, active, sort'),
        ]);
        if (!alive || s.error || r.error) return;
        const rooms = parseFolioRooms(r.data);
        setStays(
          parseStays(s.data).map((x) => ({
            id: x.id,
            label: stayLabel(rooms.find((y) => y.id === x.roomId)?.name ?? '', x),
          })),
        );
      } catch {
        /* offline: no Room tab */
      }
    })();
    return () => {
      alive = false;
    };
  }, [ctx.client, active]);
  return stays;
}
