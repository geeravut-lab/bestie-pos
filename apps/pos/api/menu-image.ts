// Vercel Function: GET /api/menu-image?i=<item id>&v=<version> — the picture of a menu item (public, cached by version).
import { menuImageResponse } from '../../../functions/src/menu-image.js';

export const GET = (request: Request): Promise<Response> => menuImageResponse(request);
