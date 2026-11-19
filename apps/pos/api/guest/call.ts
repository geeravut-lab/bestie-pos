// Vercel Function: POST /api/guest/call — the guest asks for staff (closed reason, table token, no account).
import { guestCallResponse } from '../../../../functions/src/guest-handler.js';

export const POST = (request: Request): Promise<Response> => guestCallResponse(request);
