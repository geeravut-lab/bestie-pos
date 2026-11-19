// Vercel Function: POST /api/menu/ai-translate — a signed-in owner / manager asks for a DRAFT translation of one menu name.
import { menuTranslateResponse } from '../../../../functions/src/food-ai-handler.js';

export const POST = (request: Request): Promise<Response> => menuTranslateResponse(request);
