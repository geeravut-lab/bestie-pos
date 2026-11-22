// Vercel Function: POST /api/payments/refund — give money back through the payment provider on a bill paid that way (refund.create).
import { refundResponse } from '../../../../functions/src/reconcile-handler.js';

export const POST = (request: Request): Promise<Response> => refundResponse(request);
