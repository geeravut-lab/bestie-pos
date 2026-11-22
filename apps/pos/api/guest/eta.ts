// Vercel Function: GET /api/guest/eta?token=… — about how many minutes until the kitchen finishes this table's order (the table's QR token is the only key).
import { guestEtaResponse } from '../../../../functions/src/guest-extras-handler.js';

export const GET = (request: Request): Promise<Response> => guestEtaResponse(request);
