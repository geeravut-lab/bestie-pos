// Vercel Function: POST /api/shift/summary — "Explain this shift" (owner / manager; numbers from SQL, checked in the answer).
import { shiftSummaryResponse } from '../../../../functions/src/staff-ai-handler.js';

export const POST = (request: Request): Promise<Response> => shiftSummaryResponse(request);
