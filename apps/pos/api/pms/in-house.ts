// Vercel Function: GET /api/pms/in-house?store=<id> — guests checked in at the hotel's own system (Mews / Cloudbeds), for the folio's check-in.
import { pmsInHouseResponse } from '../../../../functions/src/pms-sync.js';

export const GET = (request: Request): Promise<Response> => pmsInHouseResponse(request);
