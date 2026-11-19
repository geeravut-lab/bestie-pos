// Vercel Function: GET /api/guest/info — guest table page (the table token is the only key).
import { guestInfoResponse } from '../../../../functions/src/guest-extras-handler.js';

export const GET = (request: Request): Promise<Response> => guestInfoResponse(request);
