import type { ReactNode } from 'react';
import { adminPages } from '@bestie/admin-ui';
import type { PageContext } from '@bestie/auth';
import { FloorPlanPage } from './FloorPlanPage';
import { OrderPage } from './OrderPage';
import { OrdersPage } from './OrdersPage';
import { ShiftPage } from './ShiftPage';
import { ReceiptPage, ReceiptsPage } from './ReceiptPages';

/** Till screens first, then the back-office pages (a manager at the till can still open /menu, /staff …). */
export function posPages(ctx: PageContext): ReactNode | null {
  if (ctx.path === '/tables' || ctx.path === '/take-order') return <FloorPlanPage ctx={ctx} />;
  if (ctx.path === '/sell' || ctx.path === '/orders' || ctx.path === '/queue')
    return <OrdersPage ctx={ctx} mode={ctx.path === '/sell' ? 'sell' : 'list'} />;
  const m = /^\/order\/([0-9a-f-]{36})$/.exec(ctx.path);
  if (m) return <OrderPage ctx={ctx} orderId={m[1]!} />;
  if (ctx.path === '/shift') return <ShiftPage ctx={ctx} />;
  if (ctx.path === '/receipts') return <ReceiptsPage ctx={ctx} />;
  const r = /^\/receipt\/([0-9a-f-]{36})$/.exec(ctx.path);
  if (r) return <ReceiptPage ctx={ctx} orderId={r[1]!} />;
  return adminPages(ctx);
}
