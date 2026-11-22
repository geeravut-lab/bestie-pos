import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageName, trackPage } from './useUsageTracking';

describe('pageName', () => {
  it('names a screen, never a record', () => {
    expect(pageName('/')).toBe('home');
    expect(pageName('/reports')).toBe('reports');
    expect(pageName('/stock/insights')).toBe('stock_insights');
    expect(pageName('/order/3f2a1c9e-1111-4222-8333-444455556666')).toBe('order');
    expect(pageName('/receipt/123456')).toBe('receipt');
    expect(pageName('/admin/ai/prompts')).toBe('admin_ai');
    expect(pageName('/Weird Page/Ünï')).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('trackPage', () => {
  beforeEach(() => globalThis.localStorage?.clear());
  const client = () => {
    const calls: unknown[] = [];
    return {
      calls,
      c: {
        rpc: vi.fn(async (fn: string, args: unknown) => (calls.push({ fn, args }), { data: null })),
      } as never,
    };
  };
  it('sends "active" once a day and each screen once a day', () => {
    const { calls, c } = client();
    trackPage(c, '/reports');
    trackPage(c, '/reports');
    trackPage(c, '/menu');
    expect(calls).toEqual([
      { fn: 'track_event', args: { p_event: 'active', p_detail: null } },
      { fn: 'track_event', args: { p_event: 'page_view', p_detail: 'reports' } },
      { fn: 'track_event', args: { p_event: 'page_view', p_detail: 'menu' } },
    ]);
  });
  it('does nothing without a client and survives a server that refuses', () => {
    trackPage(null, '/x');
    const bad = {
      rpc: vi.fn(async () => {
        throw new Error('down');
      }),
    } as never;
    expect(() => trackPage(bad, '/y')).not.toThrow();
  });
});
