// Vercel Function: POST /api/guest/info-ask — guest table page (the table token is the only key).
import { guestInfoAskResponse } from '../../../../functions/src/guest-extras-handler.js';

export const POST = (request: Request): Promise<Response> => guestInfoAskResponse(request);
