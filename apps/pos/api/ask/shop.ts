// Vercel Function: POST /api/ask/shop — "Ask my shop" (owner / manager; read only, numbers from SQL).
import { askShopResponse } from '../../../../functions/src/ask-shop-handler.js';

export const POST = (request: Request): Promise<Response> => askShopResponse(request);
