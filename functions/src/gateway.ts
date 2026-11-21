/**
 * Payment gateway adapter: the ONE place that knows which payment provider (PSP) is behind PromptPay QR and card readers.
 *
 * The handlers (payment-handler.ts, guest-handler.ts) only talk to `PaymentGateway`. A provider is added by writing one more
 * adapter (start a QR, start a reader payment, cancel, verify + read a webhook) and registering it in `GATEWAYS`; the till,
 * the database functions and the rules that decide "paid" do not change. The rules stay the same for every provider:
 *   - only a provider's SIGNED webhook can say "paid" (the till and the guest page never do);
 *   - the database re-checks amount, currency and the bill before it closes anything (`confirm_payment_attempt`);
 *   - we send the provider our attempt id and bill id only, never customer data.
 *
 * Which provider is active: env `PAYMENT_GATEWAY` (default `stripe`). Unknown or not configured → `null` (the till says
 * "not configured"); a deployment never silently falls back to another provider.
 */
import { GatewayError } from './gateway-error.js';
import {
  cancelProviderPayment,
  createStripeClient,
  startPromptPay,
  startReaderPayment,
  stripeConfig,
  verifyStripeSignature,
} from './stripe.js';
import type { StripeClient } from './stripe.js';
import { createOmiseClient, omiseConfig, omiseGateway } from './omise.js';

type Env = Record<string, string | undefined>;

/** What a started payment gives back: the provider's reference, and for PromptPay what the guest scans. */
export { GatewayError };

export type StartedPayment = {
  providerRef: string;
  qrImageUrl: string | null;
  qrData: string | null;
};

/** A webhook, translated into what Bestie cares about. Money is in satang, currency lower case ("thb"). */
export type GatewayEvent =
  | {
      kind: 'succeeded';
      eventId: string | null;
      /** The provider's own event name, kept in the event log. */
      type: string;
      attemptId: string;
      providerRef: string;
      amount: number;
      currency: string;
    }
  | {
      kind: 'failed' | 'canceled';
      eventId: string | null;
      type: string;
      attemptId: string;
      error: string;
    }
  | { kind: 'ignored'; eventId: string | null; type: string };

export type PaymentGateway = {
  /** Stored on every attempt (`payment_attempts.provider`) and checked against the webhook that confirms it. */
  id: string;
  startPromptPay(p: {
    attemptId: string;
    orderId: string | null;
    amount: number;
  }): Promise<StartedPayment>;
  startReader(p: {
    attemptId: string;
    orderId: string | null;
    amount: number;
    readerId: string;
  }): Promise<StartedPayment>;
  /** Best effort: stop waiting. A payment that already went through is never undone by this. */
  cancel(p: { providerRef: string; readerId: string | null }): Promise<void>;
  /**
   * Check the webhook's signature over the RAW body and translate it. `null` = the signature is wrong (answer 400).
   * A genuine event Bestie does not care about is `{ kind: 'ignored' }`.
   */
  readWebhook(p: { rawBody: string; headers: Headers }): GatewayEvent | null;
};

const UUID = /^[0-9a-f-]{36}$/i;

// ── Stripe ──────────────────────────────────────────────────────────────────
type StripeEvent = {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      amount?: number;
      amount_received?: number;
      currency?: string;
      metadata?: Record<string, string>;
      last_payment_error?: { code?: string };
    };
  };
};

export function stripeGateway(
  client: StripeClient,
  cfg: { webhookSecret: string; siteHost: string },
): PaymentGateway {
  return {
    id: 'stripe',
    startPromptPay: (p) => startPromptPay(client, { ...p, siteHost: cfg.siteHost }),
    startReader: (p) => startReaderPayment(client, p),
    cancel: (p) => cancelProviderPayment(client, p),
    readWebhook({ rawBody, headers }) {
      if (
        !verifyStripeSignature({
          rawBody,
          header: headers.get('stripe-signature'),
          secret: cfg.webhookSecret,
        })
      )
        return null;
      let event: StripeEvent;
      try {
        event = JSON.parse(rawBody) as StripeEvent;
      } catch {
        return null;
      }
      const eventId = typeof event.id === 'string' ? event.id : null;
      const obj = event.data?.object;
      const attemptId = obj?.metadata?.attempt_id;
      if (typeof attemptId !== 'string' || !UUID.test(attemptId))
        return { kind: 'ignored', eventId, type: event.type ?? '' };
      if (event.type === 'payment_intent.succeeded' && typeof obj?.id === 'string')
        return {
          kind: 'succeeded',
          eventId,
          type: event.type,
          attemptId,
          providerRef: obj.id,
          amount: obj.amount_received ?? obj.amount ?? 0,
          currency: obj.currency ?? '',
        };
      if (event.type === 'payment_intent.payment_failed')
        return {
          kind: 'failed',
          eventId,
          type: event.type,
          attemptId,
          error: obj?.last_payment_error?.code ?? event.type,
        };
      if (event.type === 'payment_intent.canceled')
        return { kind: 'canceled', eventId, type: event.type, attemptId, error: event.type };
      return { kind: 'ignored', eventId, type: event.type ?? '' };
    },
  };
}

// ── the registry ────────────────────────────────────────────────────────────
type Deps = { fetchImpl?: typeof fetch; stripe?: StripeClient; gateway?: PaymentGateway };

/**
 * One factory per provider id. A factory returns `null` when that provider's secrets are not set, so "not configured" is
 * the same answer for every provider. To add a provider: write its adapter above, add one line here, give it a webhook route.
 */
export const GATEWAYS: Record<string, (env: Env, deps: Deps) => PaymentGateway | null> = {
  stripe(env, deps) {
    const cfg = stripeConfig(env);
    if (!cfg) return null;
    return stripeGateway(
      deps.stripe ?? createStripeClient(cfg.secretKey, deps.fetchImpl ?? fetch),
      cfg,
    );
  },
  omise(env, deps) {
    const cfg = omiseConfig(env);
    if (!cfg) return null;
    return omiseGateway(createOmiseClient(cfg.secretKey, deps.fetchImpl ?? fetch), cfg);
  },
};

/** The id the deployment uses (`PAYMENT_GATEWAY`, default `stripe`); a name that is not registered is refused, never guessed. */
export function activeGatewayId(env: Env): string {
  const v = env.PAYMENT_GATEWAY?.trim().toLowerCase();
  return v ? v : 'stripe';
}

/** The configured gateway, or `null` (not set up / unknown provider). A test or a caller may hand one in through `deps.gateway`. */
export function gatewayFromEnv(env: Env, deps: Deps = {}): PaymentGateway | null {
  if (deps.gateway) return deps.gateway;
  const make = GATEWAYS[activeGatewayId(env)];
  return make ? make(env, deps) : null;
}

/** True when a provider is set up (used to show / hide "pay at the table" without building a client). */
export function gatewayReady(env: Env): boolean {
  const make = GATEWAYS[activeGatewayId(env)];
  return !!make && make(env, {}) !== null;
}
