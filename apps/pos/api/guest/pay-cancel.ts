// Vercel Function: POST /api/guest/pay-cancel — the guest stops waiting for the PromptPay QR.
import { guestPayCancelResponse } from '../../../../functions/src/guest-handler.js';

export const POST = (request: Request): Promise<Response> => guestPayCancelResponse(request);
