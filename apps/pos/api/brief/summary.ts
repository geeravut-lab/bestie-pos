// Vercel Function: POST /api/brief/summary — the morning brief of the business manager (report.view + module ai.business_manager).
import { briefSummaryResponse } from '../../../../functions/src/brief-handler.js';

export const POST = (request: Request): Promise<Response> => briefSummaryResponse(request);
