// Vercel Function: POST /api/guest/feedback — guest table page (the table token is the only key).
import { guestFeedbackResponse } from '../../../../functions/src/guest-extras-handler.js';

export const POST = (request: Request): Promise<Response> => guestFeedbackResponse(request);
