// Vercel Function: POST /api/crypto/request — staff asks for a crypto top-up payment request (module is legally gated).
import { cryptoRequestResponse } from '../../../../functions/src/crypto-handler.js';

export const POST = (request: Request): Promise<Response> => cryptoRequestResponse(request);
