// Vercel Function: GET|POST /api/crypto/poll — scheduled watcher of the company wallets (Vercel Cron, CRON_SECRET).
import { cryptoPollResponse } from '../../../../functions/src/crypto-handler.js';

export const GET = (request: Request): Promise<Response> => cryptoPollResponse(request);
export const POST = (request: Request): Promise<Response> => cryptoPollResponse(request);
