// Vercel Function: GET /api/guest/menu?t=<table token> — the menu and bill of one table, for the QR page.
import { guestMenuResponse } from '../../../../functions/src/guest-handler.js';

export const GET = (request: Request): Promise<Response> => guestMenuResponse(request);
