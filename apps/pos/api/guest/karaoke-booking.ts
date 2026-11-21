// Vercel Function: GET|POST /api/guest/karaoke-booking — online booking of karaoke rooms (the shop's karaoke booking link token is the only key).
import { guestKaraokeBookingResponse } from '../../../../functions/src/karaoke-booking-handler.js';

export const GET = (request: Request): Promise<Response> => guestKaraokeBookingResponse(request);
export const POST = (request: Request): Promise<Response> => guestKaraokeBookingResponse(request);
