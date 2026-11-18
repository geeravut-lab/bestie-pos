import { describe, expect, it } from 'vitest';
import {
  EMPTY_AI_SETTINGS,
  PROVIDERS,
  PROVIDER_IDS,
  TASKS,
  TASK_IDS,
  aiSettingsToColumns,
  parseAiSettings,
  resolveRoute,
  roleCanUseTask,
  shouldRetrySame,
  shouldTryFallback,
  validModelId,
} from './ai';
import type { ProviderId } from './ai';

const keys =
  (...have: ProviderId[]) =>
  (p: ProviderId) =>
    have.includes(p);

describe('registry', () => {
  it('every default model id is well-formed and never the most expensive tier', () => {
    for (const t of TASK_IDS)
      for (const p of PROVIDER_IDS) {
        expect(validModelId(TASKS[t].models[p]), `${t}/${p}`).toBe(true);
        expect(TASKS[t].models[p]).not.toMatch(/opus/); // the dearest model is never a default
      }
  });
  it('requests only go to the providers themselves (locked base URLs)', () => {
    expect(PROVIDERS.anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(PROVIDERS.google.baseUrl).toBe('https://generativelanguage.googleapis.com');
  });
  it('safety and review have no fallback and cannot be extended', () => {
    for (const id of ['safety', 'prompt_review'] as const) {
      expect(TASKS[id].fallback).toBeNull();
      expect(TASKS[id].editablePrompt).toBe(false);
    }
  });
});

describe('who gets an assistant', () => {
  it('owner and manager get the business tasks; the kitchen never gets any', () => {
    expect(roleCanUseTask('owner', 'ask_shop')).toBe(true);
    expect(roleCanUseTask('manager', 'summary')).toBe(true);
    expect(roleCanUseTask('cashier', 'ask_shop')).toBe(false);
    expect(roleCanUseTask('cashier', 'howto')).toBe(true);
    expect(roleCanUseTask('guest', 'guest_menu_qa')).toBe(true);
    for (const t of TASK_IDS) expect(roleCanUseTask('kitchen', t)).toBe(false);
  });
});

describe('parseAiSettings / aiSettingsToColumns', () => {
  it('drops unknown tasks, providers and malformed model ids; never throws', () => {
    const s = parseAiSettings(
      {
        ask_shop: { primary: 'google', fallback: 'none' },
        bogus: { primary: 'google' },
        summary: { primary: 'openai' },
      },
      {
        anthropic: { ask_shop: 'claude-sonnet-5-5', summary: 'bad model!' },
        evil: { ask_shop: 'x' },
      },
    );
    expect(s).toEqual({
      routes: { ask_shop: { primary: 'google', fallback: 'none' } },
      models: { anthropic: { ask_shop: 'claude-sonnet-5-5' } },
    });
    expect(parseAiSettings(null, 'x')).toEqual(EMPTY_AI_SETTINGS);
  });
  it('stores only what differs from the defaults and round-trips', () => {
    const s = {
      routes: {
        ask_shop: { primary: 'google' as const, fallback: 'anthropic' as const },
        summary: { primary: 'anthropic' as const },
      },
      models: { google: { ask_shop: 'gemini-x', summary: TASKS.summary.models.google } },
    };
    const cols = aiSettingsToColumns(s);
    expect(cols.route_overrides).toEqual({
      ask_shop: { primary: 'google', fallback: 'anthropic' },
    }); // summary's primary equals its default → not stored
    expect(cols.model_overrides).toEqual({ google: { ask_shop: 'gemini-x' } });
    expect(
      parseAiSettings(cols.route_overrides, cols.model_overrides).routes.ask_shop?.primary,
    ).toBe('google');
  });
});

describe('resolveRoute', () => {
  it('uses the code defaults when the admin changed nothing', () => {
    const r = resolveRoute('ask_shop', EMPTY_AI_SETTINGS, keys('anthropic', 'google'))!;
    expect(r.primary).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(r.fallback?.provider).toBe('google');
    expect(r.primarySkipped).toBeNull();
  });
  it('honours the admin choice of provider, model and "no fallback"', () => {
    const s = parseAiSettings(
      { ask_shop: { primary: 'google', fallback: 'none' } },
      { google: { ask_shop: 'gemini-custom' } },
    );
    const r = resolveRoute('ask_shop', s, keys('anthropic', 'google'))!;
    expect(r.primary).toEqual({ provider: 'google', model: 'gemini-custom' });
    expect(r.fallback).toBeNull();
  });
  it('skips a provider with no key and reports it', () => {
    const r = resolveRoute('ask_shop', EMPTY_AI_SETTINGS, keys('google'))!;
    expect(r.primary.provider).toBe('google');
    expect(r.primarySkipped).toBe('anthropic');
    expect(r.fallback).toBeNull();
  });
  it('is null (= not configured) when no usable key exists', () => {
    expect(resolveRoute('ask_shop', EMPTY_AI_SETTINGS, keys())).toBeNull();
  });
  it('safety has no fallback: with its only provider unavailable it stays unavailable instead of silently switching', () => {
    expect(resolveRoute('safety', EMPTY_AI_SETTINGS, keys('google'))).toBeNull();
    expect(resolveRoute('safety', EMPTY_AI_SETTINGS, keys('anthropic'))!.fallback).toBeNull();
  });
  it('a fallback equal to the primary is ignored; a keyless fallback is dropped', () => {
    const s = parseAiSettings({ ask_shop: { primary: 'anthropic', fallback: 'anthropic' } }, {});
    expect(resolveRoute('ask_shop', s, keys('anthropic', 'google'))!.fallback).toBeNull();
    expect(resolveRoute('ask_shop', EMPTY_AI_SETTINGS, keys('anthropic'))!.fallback).toBeNull();
  });
});

describe('fallback rules', () => {
  it('falls back on rate limit, server errors and dead keys, not on bad requests', () => {
    for (const s of [429, 500, 502, 503, 401, 403])
      expect(shouldTryFallback(s), String(s)).toBe(true);
    for (const s of [400, 404, 422]) expect(shouldTryFallback(s), String(s)).toBe(false);
    expect(shouldRetrySame(503)).toBe(true);
    expect(shouldRetrySame(401)).toBe(false);
  });
});
