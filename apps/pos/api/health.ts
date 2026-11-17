// Vercel Function (Web Fetch API signature). Deploy smoke test: GET /api/health
//
// Relative import on purpose: Vercel compiles each function's own import graph, and a package
// name that points at `.ts` source (workspace packages) does not resolve inside the Lambda.
// Relative imports inside `functions/src` also carry explicit `.js` extensions for Node ESM.
import { healthResponse } from '../../../functions/src/index.js';

export function GET(): Response {
  return healthResponse();
}
