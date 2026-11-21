// Vercel Function: GET|POST /api/guest/karaoke — the karaoke room page (the room's QR token is the only key).
import { guestKaraokeResponse } from '../../../../functions/src/karaoke-handler.js';

export const GET = (request: Request): Promise<Response> => guestKaraokeResponse(request);
export const POST = (request: Request): Promise<Response> => guestKaraokeResponse(request);
