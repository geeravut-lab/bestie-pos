// Vercel Function: POST /api/stripe/charge — the till asks for a PromptPay QR / card-reader payment for one bill.
import { stripeChargeResponse } from '../../../../functions/src/payment-handler.js';

export const POST = (request: Request): Promise<Response> => stripeChargeResponse(request);
