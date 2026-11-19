// Vercel Function: POST /api/guest/ai — the guest's words → a food filter (no account; the table token is the key).
import { guestAiResponse } from '../../../../functions/src/food-ai-handler.js';

export const POST = (request: Request): Promise<Response> => guestAiResponse(request);
