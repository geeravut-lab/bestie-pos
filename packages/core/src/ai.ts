/**
 * AI assistant configuration (docs/AI-PROVIDER-MODEL-KNOWLEDGE.md), pure and unit-tested.
 *
 * Rules carried over from the knowledge file:
 *  - the platform admin chooses provider + model PER TASK (with an optional fallback); everything is optional and parsed
 *    leniently, so a half-written row falls back to the defaults in this file and never breaks a feature;
 *  - a provider whose API key is missing is never used (and never selectable);
 *  - the model READS and EXPLAINS; money, tax, points and permissions are computed in code (packages/core), never by AI;
 *  - the default model is never the most expensive one; the safety task has no fallback (stable behaviour).
 */
export const PROVIDER_IDS = ['anthropic', 'google'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type Capability = 'text' | 'images' | 'pdf' | 'audio';

export type ProviderDef = {
  id: ProviderId;
  label: string;
  /** Name of the SERVER environment variable that holds the key (the value is never shown anywhere). */
  envKey: string;
  /** Other accepted names for the same key (e.g. Google AI Studio calls it GOOGLE_AI_API_KEY in some setups). */
  envKeyAliases?: readonly string[];
  capabilities: readonly Capability[];
  /** Locked: requests only ever go to the provider itself, never to a configurable base URL (key-exfiltration guard). */
  baseUrl: string;
};

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDef>> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    envKey: 'ANTHROPIC_API_KEY',
    capabilities: ['text', 'images', 'pdf'],
    baseUrl: 'https://api.anthropic.com',
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    envKeyAliases: ['GOOGLE_AI_API_KEY'],
    capabilities: ['text', 'images', 'pdf', 'audio'],
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
};

export const TASK_IDS = [
  'ask_shop',
  'summary',
  'menu_translate',
  'menu_describe',
  'menu_tags',
  'howto',
  'guest_menu_qa',
  'concierge',
  'safety',
  'prompt_review',
] as const;
export type TaskId = (typeof TASK_IDS)[number];

export type AppRoleName =
  'owner' | 'manager' | 'cashier' | 'waiter' | 'kitchen' | 'guest' | 'platformAdmin';

export type TaskDef = {
  id: TaskId;
  needs: readonly Capability[];
  primary: ProviderId;
  /** `null` = no fallback by design. */
  fallback: ProviderId | null;
  models: Readonly<Record<ProviderId, string>>;
  /** Who may use this task (KNOWLEDGE-MAPPING §B). The kitchen screen never gets an assistant. */
  roles: readonly AppRoleName[];
  /** Safety / review tasks are part of the guard rails: admins cannot add instructions to them. */
  editablePrompt: boolean;
  /** Cheap by default: model tier used when nothing is configured. */
  tier: 'small' | 'medium';
};

const CLAUDE_SMALL = 'claude-haiku-5-5';
const CLAUDE_MEDIUM = 'claude-sonnet-5-5';
const GEMINI = 'gemini-3-flash-preview';
const GEMINI_LITE = 'gemini-flash-lite-latest';

export const TASKS: Readonly<Record<TaskId, TaskDef>> = {
  ask_shop: {
    id: 'ask_shop',
    needs: ['text'],
    primary: 'anthropic',
    fallback: 'google',
    models: { anthropic: CLAUDE_MEDIUM, google: GEMINI },
    roles: ['owner', 'manager'],
    editablePrompt: true,
    tier: 'medium',
  },
  summary: {
    id: 'summary',
    needs: ['text'],
    primary: 'anthropic',
    fallback: 'google',
    models: { anthropic: CLAUDE_SMALL, google: GEMINI_LITE },
    roles: ['owner', 'manager'],
    editablePrompt: true,
    tier: 'small',
  },
  menu_translate: {
    id: 'menu_translate',
    needs: ['text'],
    primary: 'google',
    fallback: 'anthropic',
    models: { anthropic: CLAUDE_SMALL, google: GEMINI },
    roles: ['owner', 'manager'],
    editablePrompt: true,
    tier: 'small',
  },
  concierge: {
    id: 'concierge',
    needs: ['text'],
    primary: 'anthropic',
    fallback: 'google',
    models: { anthropic: CLAUDE_SMALL, google: GEMINI_LITE },
    roles: ['guest'],
    editablePrompt: true,
    tier: 'small',
  },
  menu_describe: {
    id: 'menu_describe',
    needs: ['text', 'images'],
    primary: 'google',
    fallback: 'anthropic',
    models: { anthropic: CLAUDE_SMALL, google: GEMINI },
    roles: ['owner', 'manager'],
    editablePrompt: true,
    tier: 'small',
  },
  menu_tags: {
    id: 'menu_tags',
    needs: ['text'],
    primary: 'anthropic',
    fallback: 'google',
    models: { anthropic: CLAUDE_SMALL, google: GEMINI_LITE },
    roles: ['owner', 'manager'],
    editablePrompt: true,
    tier: 'small',
  },
  howto: {
    id: 'howto',
    needs: ['text'],
    primary: 'anthropic',
    fallback: 'google',
    models: { anthropic: CLAUDE_SMALL, google: GEMINI_LITE },
    roles: ['cashier', 'waiter', 'manager', 'owner'],
    editablePrompt: true,
    tier: 'small',
  },
  guest_menu_qa: {
    id: 'guest_menu_qa',
    needs: ['text'],
    primary: 'anthropic',
    fallback: 'google',
    models: { anthropic: CLAUDE_SMALL, google: GEMINI_LITE },
    roles: ['guest'],
    editablePrompt: true,
    tier: 'small',
  },
  safety: {
    id: 'safety',
    needs: ['text'],
    primary: 'anthropic',
    fallback: null,
    models: { anthropic: CLAUDE_SMALL, google: GEMINI_LITE },
    roles: ['platformAdmin'],
    editablePrompt: false,
    tier: 'small',
  },
  prompt_review: {
    id: 'prompt_review',
    needs: ['text'],
    primary: 'anthropic',
    fallback: null,
    models: { anthropic: CLAUDE_SMALL, google: GEMINI_LITE },
    roles: ['platformAdmin'],
    editablePrompt: false,
    tier: 'small',
  },
};

export const isProviderId = (v: unknown): v is ProviderId =>
  typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
export const isTaskId = (v: unknown): v is TaskId =>
  typeof v === 'string' && (TASK_IDS as readonly string[]).includes(v);

/** Does this role get an assistant for this task? The kitchen never does. */
export const roleCanUseTask = (role: AppRoleName, task: TaskId): boolean =>
  role !== 'kitchen' && TASKS[task].roles.includes(role);

export const MODEL_ID = /^[A-Za-z0-9._:/-]{1,100}$/;
export const validModelId = (v: unknown): v is string => typeof v === 'string' && MODEL_ID.test(v);

// ── settings (what the admin edited) ────────────────────────────────────────
export type RouteOverride = {
  primary?: ProviderId;
  /** 'none' = switch the fallback off */ fallback?: ProviderId | 'none';
};
export type AiSettings = {
  routes: Partial<Record<TaskId, RouteOverride>>;
  models: Partial<Record<ProviderId, Partial<Record<TaskId, string>>>>;
};
export const EMPTY_AI_SETTINGS: AiSettings = { routes: {}, models: {} };

/** Lenient: unknown tasks / providers / malformed model ids are dropped, never thrown. */
export function parseAiSettings(routesRaw: unknown, modelsRaw: unknown): AiSettings {
  const routes: AiSettings['routes'] = {};
  if (routesRaw && typeof routesRaw === 'object' && !Array.isArray(routesRaw)) {
    for (const [task, v] of Object.entries(routesRaw)) {
      if (!isTaskId(task) || !v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      const r: RouteOverride = {};
      if (isProviderId(o.primary)) r.primary = o.primary;
      if (isProviderId(o.fallback) || o.fallback === 'none')
        r.fallback = o.fallback as ProviderId | 'none';
      if (r.primary || r.fallback) routes[task] = r;
    }
  }
  const models: AiSettings['models'] = {};
  if (modelsRaw && typeof modelsRaw === 'object' && !Array.isArray(modelsRaw)) {
    for (const [prov, perTask] of Object.entries(modelsRaw)) {
      if (!isProviderId(prov) || !perTask || typeof perTask !== 'object') continue;
      const m: Partial<Record<TaskId, string>> = {};
      for (const [task, model] of Object.entries(perTask))
        if (isTaskId(task) && validModelId(model)) m[task] = model;
      if (Object.keys(m).length) models[prov] = m;
    }
  }
  return { routes, models };
}

/** Write only what differs from the defaults (so a code default change reaches everyone who never customised). */
export function aiSettingsToColumns(s: AiSettings): {
  route_overrides: Record<string, unknown>;
  model_overrides: Record<string, unknown>;
} {
  const route_overrides: Record<string, unknown> = {};
  for (const task of TASK_IDS) {
    const o = s.routes[task];
    if (!o) continue;
    const def = TASKS[task];
    const r: RouteOverride = {};
    if (o.primary && o.primary !== def.primary) r.primary = o.primary;
    const defaultFallback = def.fallback ?? 'none';
    if (o.fallback && o.fallback !== defaultFallback) r.fallback = o.fallback;
    if (r.primary || r.fallback) route_overrides[task] = r;
  }
  const model_overrides: Record<string, unknown> = {};
  for (const prov of PROVIDER_IDS) {
    const per = s.models[prov];
    if (!per) continue;
    const m: Record<string, string> = {};
    for (const task of TASK_IDS) {
      const model = per[task];
      if (model && model !== TASKS[task].models[prov]) m[task] = model;
    }
    if (Object.keys(m).length) model_overrides[prov] = m;
  }
  return { route_overrides, model_overrides };
}

export type Route = {
  task: TaskId;
  primary: { provider: ProviderId; model: string };
  fallback: { provider: ProviderId; model: string } | null;
  /** The configured primary had no key and was skipped (shown as a warning to the admin). */
  primarySkipped: ProviderId | null;
};

const supports = (p: ProviderId, task: TaskId): boolean =>
  TASKS[task].needs.every((c) => PROVIDERS[p].capabilities.includes(c));

/**
 * Decide who answers. Order: admin choice → code defaults. A provider without a key, or without the capability the task
 * needs (e.g. audio), is never picked; if nothing is usable the answer is `null` = "not configured".
 */
export function resolveRoute(
  task: TaskId,
  settings: AiSettings,
  hasKey: (p: ProviderId) => boolean,
): Route | null {
  const def = TASKS[task];
  const o = settings.routes[task];
  let primary: ProviderId = o?.primary ?? def.primary;
  const wantedFallback = o?.fallback === 'none' ? null : (o?.fallback ?? def.fallback);
  let fallback: ProviderId | null =
    wantedFallback && wantedFallback !== primary ? wantedFallback : null;
  const model = (p: ProviderId) => settings.models[p]?.[task] ?? def.models[p];
  const usable = (p: ProviderId) => hasKey(p) && supports(p, task);

  let primarySkipped: ProviderId | null = null;
  if (!usable(primary)) {
    primarySkipped = primary;
    if (fallback && usable(fallback)) {
      primary = fallback;
      fallback = null;
    } else {
      const other = PROVIDER_IDS.find(
        (p) => p !== primary && usable(p) && (def.fallback !== null || o?.fallback !== undefined),
      );
      if (!other) return null;
      primary = other;
      fallback = null;
    }
  } else if (fallback && !usable(fallback)) {
    fallback = null;
  }
  return {
    task,
    primary: { provider: primary, model: model(primary) },
    fallback: fallback ? { provider: fallback, model: model(fallback) } : null,
    primarySkipped,
  };
}

/** Fall back on rate limits, server errors and dead keys (401/403); NOT on 400/404/422 — those would fail the same way elsewhere. */
export function shouldTryFallback(status: number): boolean {
  return status === 429 || status >= 500 || status === 401 || status === 403;
}
export const shouldRetrySame = (status: number): boolean => status === 429 || status === 503;
