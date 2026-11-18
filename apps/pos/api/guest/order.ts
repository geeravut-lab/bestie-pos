// Vercel Function: POST /api/guest/order — a guest sends an order from the table QR.
import { guestOrderResponse } from '../../../../functions/src/guest-handler.js';

export const POST = (request: Request): Promise<Response> => guestOrderResponse(request);
