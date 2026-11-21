// Vercel Function: POST /api/staff/translate — live translation for staff (module ai.translate).
import { staffTranslateResponse } from '../../../../functions/src/staff-ai-handler.js';

export const POST = (request: Request): Promise<Response> => staffTranslateResponse(request);
