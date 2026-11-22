// Vercel Function: GET /api/payments/reconcile — what Bestie booked through the payment provider against what the provider lists (report.view).
import { reconcileResponse } from '../../../../functions/src/reconcile-handler.js';

export const GET = (request: Request): Promise<Response> => reconcileResponse(request);
