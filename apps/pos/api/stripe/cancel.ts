// Vercel Function: POST /api/stripe/cancel — stop waiting for an online payment.
import { stripeCancelResponse } from '../../../../functions/src/payment-handler.js';

export const POST = (request: Request): Promise<Response> => stripeCancelResponse(request);
