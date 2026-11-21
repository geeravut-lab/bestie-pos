// Vercel Function: GET /api/guest/pass-wallet — the "Add to Google Wallet" link of a Tourist Pass (the pass token is the only key).
import { passWalletResponse } from '../../../../functions/src/wallet.js';

export const GET = (request: Request): Promise<Response> => passWalletResponse(request);
