import type { ReactNode } from 'react';
import { adminPages } from '@bestie/admin-ui';
import type { PageContext } from '@bestie/auth';
import { FloorPlanPage } from './FloorPlanPage';
import { OrderPage } from './OrderPage';
import { OrdersPage } from './OrdersPage';

/** Till screens first, then the back-office pages (a manager at the till can still open /menu, /staff …). */
export function posPages(ctx: PageContext): ReactNode | null {
  if (ctx.path === '/tables' || ctx.path === '/take-order') return <FloorPlanPage ctx={ctx} />;
  if (ctx.path === '/sell' || ctx.path === '/orders' || ctx.path === '/queue')
    return <OrdersPage ctx={ctx} mode={ctx.path === '/sell' ? 'sell' : 'list'} />;
  const m = /^\/order\/([0-9a-f-]{36})$/.exec(ctx.path);
  if (m) return <OrderPage ctx={ctx} orderId={m[1]!} />;
  return adminPages(ctx);
}
