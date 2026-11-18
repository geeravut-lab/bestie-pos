// Vercel Function: POST /api/crypto/check — look at the chain now for one request's wallet.
import { cryptoCheckResponse } from '../../../../functions/src/crypto-handler.js';

export const POST = (request: Request): Promise<Response> => cryptoCheckResponse(request);
