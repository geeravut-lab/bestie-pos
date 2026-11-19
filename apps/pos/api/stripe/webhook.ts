// Vercel Function: POST /api/stripe/webhook — Stripe → Bestie. The only thing that closes a PromptPay / card bill.
import { stripeWebhookResponse } from '../../../../functions/src/payment-handler.js';

export const POST = (request: Request): Promise<Response> => stripeWebhookResponse(request);
