// Vercel Function: GET|POST /api/karaoke/bridge — the Bestie Song Bridge in a karaoke room (its bridge key is the only key).
import { karaokeBridgeResponse } from '../../../../functions/src/karaoke-bridge-handler.js';

export const GET = (request: Request): Promise<Response> => karaokeBridgeResponse(request);
export const POST = (request: Request): Promise<Response> => karaokeBridgeResponse(request);
