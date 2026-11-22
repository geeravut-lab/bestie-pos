// Vercel Function: POST /api/receipt/send — a paid bill's receipt by e-mail or LINE.
import { receiptSendResponse } from '../../../../functions/src/receipt-handler.js';

export const POST = (request: Request): Promise<Response> => receiptSendResponse(request);
