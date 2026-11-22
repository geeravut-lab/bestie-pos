// Vercel Function: GET /api/v1/sales — read-only sales per shop and day for the owner's API key.
import { publicApiResponse } from '../../../../functions/src/public-api-handler.js';

export const GET = (request: Request): Promise<Response> => publicApiResponse(request, 'sales');
