export { AuditPage } from './AuditPage';
export { BillingPage } from './BillingPage';
export { BrandingPage } from './BrandingPage';
export { DevicesPage } from './DevicesPage';
export { MenuPage } from './MenuPage';
export { ModulesPage } from './ModulesPage';
export { StaffPage } from './StaffPage';
export { AiPromptsPage, AiSettingsPage } from './AiPages';
export { useRemote } from './useRemote';
import type { ReactNode } from 'react';
import type { PageContext } from '@bestie/auth';
import { AuditPage } from './AuditPage';
import { AiPromptsPage, AiSettingsPage } from './AiPages';
import { BillingPage } from './BillingPage';
import { BrandingPage } from './BrandingPage';
import { DevicesPage } from './DevicesPage';
import { MenuPage } from './MenuPage';
import { ModulesPage } from './ModulesPage';
import { StaffPage } from './StaffPage';

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
  if (ctx.path === '/settings/billing') return <BillingPage ctx={ctx} />;
  if (ctx.path === '/menu') return <MenuPage ctx={ctx} />;
  if (ctx.path === '/modules') return <ModulesPage ctx={ctx} />;
  if (ctx.path === '/staff') return <StaffPage ctx={ctx} />;
  if (ctx.path === '/devices') return <DevicesPage ctx={ctx} />;
  return null;
}
