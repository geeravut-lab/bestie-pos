import { useState } from 'react';
import { escposDrawerPulse } from '@bestie/core';
import type { Printer } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { sendEscpos, supportedKinds } from './drivers';
import type { PrintEnv } from './drivers';
import { usePrinters } from './usePrinters';

const PENDING = 'bestie-drawer-pending';
const readPending = (): string[] => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(PENDING) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-20) : [];
  } catch {
    return [];
  }
};
const writePending = (list: string[]) => {
  try {
    if (list.length === 0) globalThis.localStorage?.removeItem(PENDING);
    else globalThis.localStorage?.setItem(PENDING, JSON.stringify(list.slice(-20)));
  } catch {
    /* private mode */
  }
};

/** The printer whose drawer port to use: this tablet's choice, else the shop default, else any printer that has the drawer ticked. */
export function drawerPrinter(
  all: readonly Printer[],
  current: Printer,
  usable: Record<Printer['kind'], boolean>,
): Printer | null {
  const ok = (p: Printer) => p.drawer && p.kind !== 'pdf' && p.kind !== 'browser' && usable[p.kind];
  if (ok(current)) return current;
  return all.find(ok) ?? null;
}

/**
 * "Open the cash drawer" without a sale, for people who may take payments. The command goes straight to the receipt printer's drawer
 * port (works offline). Every use is recorded as a critical audit event; times of openings made offline are kept on the tablet and
 * reported with the next one, so the record is complete without ever blocking the cashier.
 */
export function OpenDrawer({
  ctx,
  storeId,
  deviceId,
  env,
}: {
  ctx: PageContext;
  storeId: string | null;
  deviceId: string | null;
  env?: PrintEnv;
}) {
  const { t } = useI18n();
  const pr = usePrinters(ctx, storeId);
  const [note, setNote] = useState<'opened' | 'none' | 'failed' | null>(null);
  const allowed = ctx.isOwner || ctx.permissions.includes('payment.take');
  if (!allowed || !deviceId) return null;

  const open = async () => {
    setNote(null);
    const printer = drawerPrinter(pr.all, pr.current, supportedKinds(env));
    if (!printer) return setNote('none');
    try {
      await sendEscpos(printer, escposDrawerPulse(), env);
    } catch {
      return setNote('failed');
    }
    setNote('opened');
    const times = [...readPending(), new Date().toISOString()];
    writePending(times);
    try {
      const { error } = await ctx.client.rpc('record_drawer_open', {
        p_device: deviceId,
        p_times: times,
      });
      if (!error) writePending([]);
    } catch {
      /* offline: reported with the next opening */
    }
  };

  return (
    <>
      <AsyncButton variant="secondary" onClick={open}>
        {t.drawerOpen}
      </AsyncButton>
      {note === 'opened' ? <Notice kind="success">{t.drawerOpened}</Notice> : null}
      {note === 'none' ? <Notice kind="info">{t.drawerNoPrinter}</Notice> : null}
      {note === 'failed' ? <Notice kind="error">{t.drawerFailed}</Notice> : null}
    </>
  );
}
