/**
 * GET /api/health — deploy smoke test. Reports *whether* things are configured, never their values.
 * Mounted by apps/pos/api/health.ts (Vercel Function, Web Fetch API signature).
 */
export type HealthReport = {
  ok: true;
  service: 'bestie-pos';
  time: string;
  config: { supabaseUrl: boolean; serviceRoleKey: boolean };
};

export function healthReport(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): HealthReport {
  return {
    ok: true,
    service: 'bestie-pos',
    time: now.toISOString(),
    config: {
      supabaseUrl: Boolean(env.SUPABASE_URL?.trim()),
      serviceRoleKey: Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    },
  };
}

export function healthResponse(env?: Record<string, string | undefined>): Response {
  return Response.json(healthReport(env), {
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
