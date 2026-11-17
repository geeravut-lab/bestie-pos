// Vercel Function: POST /api/sso-exchange — exchanges an Aivora hub ticket for a Supabase session.
// Server only (uses the service_role key). See functions/src/sso.ts and docs/SSO-Aivora-Supabase.md.
import { ssoExchangeResponse } from '../../../functions/src/sso-handler.js';

export function POST(request: Request): Promise<Response> {
  return ssoExchangeResponse(request);
}

export function GET(request: Request): Promise<Response> {
  return ssoExchangeResponse(request); // answers 405
}
