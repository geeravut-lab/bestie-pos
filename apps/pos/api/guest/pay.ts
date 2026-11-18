// Vercel Function: POST /api/guest/pay (start a PromptPay QR for the table's bill) and GET /api/guest/pay (its status).
import {
  guestPayResponse,
  guestPayStatusResponse,
} from '../../../../functions/src/guest-handler.js';

export const POST = (request: Request): Promise<Response> => guestPayResponse(request);
export const GET = (request: Request): Promise<Response> => guestPayStatusResponse(request);
