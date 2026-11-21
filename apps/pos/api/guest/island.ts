// Vercel Function: GET /api/guest/island — the public island marketplace page data.
import { guestIslandResponse } from '../../../../functions/src/network-handler.js';

export const GET = (request: Request): Promise<Response> => guestIslandResponse(request);
