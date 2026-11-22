// Vercel Function: GET /api/v1/menu — read-only menu with prices for the owner's API key.
import { publicApiResponse } from '../../../../functions/src/public-api-handler.js';

export const GET = (request: Request): Promise<Response> => publicApiResponse(request, 'menu');
