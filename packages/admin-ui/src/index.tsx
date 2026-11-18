export { AuditPage } from './AuditPage';
export { BrandingPage } from './BrandingPage';
export { AiPromptsPage, AiSettingsPage } from './AiPages';
export { useRemote } from './useRemote';
import type { ReactNode } from 'react';
import type { PageContext } from '@bestie/auth';
import { AuditPage } from './AuditPage';
import { AiPromptsPage, AiSettingsPage } from './AiPages';
import { BrandingPage } from './BrandingPage';

/** Back-office pages by path. Mounted by apps/pos and apps/admin through `AuthApp pages={adminPages}`. */
export function adminPages(ctx: PageContext): ReactNode | null {
  if (ctx.path === '/admin/audit' || ctx.path.startsWith('/admin/audit/'))
    return <AuditPage ctx={ctx} />;
  if (ctx.path === '/admin/branding' || ctx.path.startsWith('/admin/branding/'))
    return <BrandingPage ctx={ctx} />;
  if (ctx.isPlatformAdmin && ctx.path === '/ai')
    return <AiSettingsPage ctx={ctx} onNavigate={ctx.navigate} />;
  if (ctx.path === '/admin/ai/prompts')
    return <AiPromptsPage ctx={ctx} onNavigate={ctx.navigate} />;
  return null;
}
