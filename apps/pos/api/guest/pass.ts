// Vercel Function: GET|POST /api/guest/pass — the Tourist Pass page data and registration (no account).
import { guestPassResponse } from '../../../../functions/src/network-handler.js';

export const GET = (request: Request): Promise<Response> => guestPassResponse(request);
export const POST = (request: Request): Promise<Response> => guestPassResponse(request);
