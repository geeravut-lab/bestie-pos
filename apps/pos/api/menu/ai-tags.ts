// Vercel Function: POST /api/menu/ai-tags — a signed-in owner / manager asks for a DRAFT of one dish's food tags.
import { menuTagsResponse } from '../../../../functions/src/food-ai-handler.js';

export const POST = (request: Request): Promise<Response> => menuTagsResponse(request);
