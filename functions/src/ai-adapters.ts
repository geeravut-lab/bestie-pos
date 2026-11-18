/**
 * Provider adapters over plain `fetch` (no SDK): Anthropic Messages API and Google Gemini generateContent.
 * Base URLs are LOCKED to the providers themselves (never read from the environment) so a poisoned variable can never
 * send an API key to a third party. Keys are passed in by the caller and never logged or returned.
 */
import { PROVIDERS } from '../../packages/core/src/ai.js';
import type { ProviderId } from '../../packages/core/src/ai.js';

export type AiRequest = { system?: string; prompt: string; maxTokens?: number };
export type AiResponse = {
  text: string;
  provider: ProviderId;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type AiErrorCode = 'not_configured' | 'provider_failed' | 'bad_output';
export class AiError extends Error {
  readonly code: AiErrorCode;
  /** HTTP status from the provider, when there was one (drives retry / fallback). */
  readonly status: number | undefined;
  constructor(code: AiErrorCode, status?: number) {
    super(code);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export interface ProviderAdapter {
  id: ProviderId;
  call(req: AiRequest, model: string, apiKey: string): Promise<AiResponse>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createAnthropicAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    id: 'anthropic',
    async call(req, model, apiKey) {
      const res = await fetchImpl(`${PROVIDERS.anthropic.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 1024,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.prompt }],
        }),
      });
      if (!res.ok) throw new AiError('provider_failed', res.status);
      const body = (await res.json()) as {
        content?: { type?: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (body.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (!text) throw new AiError('bad_output');
      return {
        text,
        provider: 'anthropic',
        model,
        usage: {
          inputTokens: num(body.usage?.input_tokens),
          outputTokens: num(body.usage?.output_tokens),
        },
      };
    },
  };
}

export function createGoogleAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    id: 'google',
    async call(req, model, apiKey) {
      const res = await fetchImpl(
        `${PROVIDERS.google.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
            contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
            generationConfig: { maxOutputTokens: req.maxTokens ?? 1024 },
          }),
        },
      );
      if (!res.ok) throw new AiError('provider_failed', res.status);
      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new AiError('bad_output');
      return {
        text,
        provider: 'google',
        model,
        usage: {
          inputTokens: num(body.usageMetadata?.promptTokenCount),
          outputTokens: num(body.usageMetadata?.candidatesTokenCount),
        },
      };
    },
  };
}
