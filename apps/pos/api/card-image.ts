// Vercel Function: GET /api/card-image?id=<card id>&v=<version> — an admin-uploaded home-card picture.
import { cardImageHandler } from '../../../functions/src/card-image.js';

export const GET = (request: Request): Promise<Response> => cardImageHandler(request);
