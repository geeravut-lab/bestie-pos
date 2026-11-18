// Vercel Function: /api/line/link — status / new code / disconnect / test card for the signed-in user.
import { lineLinkResponse } from '../../../../functions/src/line-handler.js';

export const GET = (request: Request): Promise<Response> => lineLinkResponse(request);
export const POST = (request: Request): Promise<Response> => lineLinkResponse(request);
export const DELETE = (request: Request): Promise<Response> => lineLinkResponse(request);
