// Vercel Function: POST /api/delivery/intake — an order from a delivery platform (the platform's intake token is the only key).
import { deliveryIntakeResponse } from '../../../../functions/src/delivery-handler.js';

export const POST = (request: Request): Promise<Response> => deliveryIntakeResponse(request);
