// Vercel Function: GET|POST /api/guest/tour — online booking of tour seats (the shop's tour link token is the only key).
import { guestTourBookingResponse } from '../../../../functions/src/tour-booking-handler.js';

export const GET = (request: Request): Promise<Response> => guestTourBookingResponse(request);
export const POST = (request: Request): Promise<Response> => guestTourBookingResponse(request);
