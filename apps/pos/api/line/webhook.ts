// Vercel Function: POST /api/line/webhook — LINE Platform → Bestie (account linking, unfollow).
import { lineWebhookResponse } from '../../../../functions/src/line-handler.js';

export function POST(request: Request): Promise<Response> {
  return lineWebhookResponse(request);
}
