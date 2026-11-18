// Vercel Function: GET /api/brand?kind=logo|favicon|manifest (reached via the /brand/* and /manifest.webmanifest rewrites).
import { brandHandler } from '../../../functions/src/brand-handler.js';

export function GET(request: Request): Promise<Response> {
  return brandHandler(request);
}
