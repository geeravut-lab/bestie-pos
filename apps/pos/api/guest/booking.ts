// Vercel Function: GET|POST /api/guest/booking — online booking (the shop's booking link token is the only key).
import { guestBookingResponse } from '../../../../functions/src/booking-handler.js';

export const GET = (request: Request): Promise<Response> => guestBookingResponse(request);
export const POST = (request: Request): Promise<Response> => guestBookingResponse(request);
