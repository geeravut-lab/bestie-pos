import { healthResponse } from '@bestie/functions';

// Vercel Function (Web Fetch API signature). Deploy smoke test: GET /api/health
export function GET(): Response {
  return healthResponse();
}
