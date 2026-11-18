// Vercel Function: /api/ai?op=status|test|review — platform admin only (see functions/src/ai-handler.ts).
import { aiHandler } from '../../../functions/src/ai-handler.js';

export function GET(request: Request): Promise<Response> {
  return aiHandler(request);
}

export function POST(request: Request): Promise<Response> {
  return aiHandler(request);
}
