// Vercel Function: POST /api/omise/webhook — Omise → Bestie (only when PAYMENT_GATEWAY=omise). The only thing that closes a PromptPay bill with Omise.
import { paymentWebhookResponse } from '../../../../functions/src/payment-handler.js';

export const POST = (request: Request): Promise<Response> => paymentWebhookResponse(request);
