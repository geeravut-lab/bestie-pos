export { AuditPage } from './AuditPage';
export { BrandingPage } from './BrandingPage';
export { useRemote } from './useRemote';
import type { ReactNode } from 'react';
import type { PageContext } from '@bestie/auth';
import { AuditPage } from './AuditPage';
import { BrandingPage } from './BrandingPage';

/** Back-office pages by path. Mounted by apps/pos and apps/admin through `AuthApp pages={adminPages}`. */
export function adminPages(ctx: PageContext): ReactNode | null {
  if (ctx.path === '/admin/audit' || ctx.path.startsWith('/admin/audit/'))
    return <AuditPage ctx={ctx} />;
  if (ctx.path === '/admin/branding' || ctx.path.startsWith('/admin/branding/'))
    return <BrandingPage ctx={ctx} />;
  return null;
}
