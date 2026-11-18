// Vercel Function: GET|POST /api/notify/tick — scheduled delivery of LINE notices (CRON_SECRET).
import { notifyTickResponse } from '../../../../functions/src/notify-handler.js';

export const GET = (request: Request): Promise<Response> => notifyTickResponse(request);
export const POST = (request: Request): Promise<Response> => notifyTickResponse(request);
