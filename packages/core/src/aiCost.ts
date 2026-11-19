/**
 * What the AI costs a business (docs/AI-PROVIDER-MODEL-KNOWLEDGE.md §2.3). The log stores tokens only; money is computed here, on
 * read, from model prices (code defaults, corrected by `ai_settings.prices`) and the USD→THB rate (`ai_settings.usd_thb`), so a
 * corrected price fixes the past figures too. Money is integer satang. Prices are the Oct 2026 reference list: CHECK THEM before
 * billing anybody.
 */

/** USD per 1M tokens, input / output. */
export type ModelPrice = { in: number; out: number };

export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-opus-5-5': { in: 4, out: 20 },
  'gemini-3-flash-preview': { in: 0.5, out: 3 },
  'gemini-flash-lite-latest': { in: 0.3, out: 2.5 },
};
export const DEFAULT_USD_THB = 36;

/** Defaults overlaid with what the platform admin corrected; a bad entry is ignored. */
export function mergePrices(raw: unknown): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICES };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [model, v] of Object.entries(raw)) {
      const p = v as { in?: unknown; out?: unknown } | null;
      if (
        typeof p?.in === 'number' &&
        typeof p.out === 'number' &&
        Number.isFinite(p.in) &&
        Number.isFinite(p.out) &&
        p.in >= 0 &&
        p.out >= 0 &&
        /^[A-Za-z0-9._:/-]{1,100}$/.test(model)
      )
        out[model] = { in: p.in, out: p.out };
    }
  }
  return out;
}

/** Estimated cost in satang, or null when the model has no price (shown as "no price yet", never as 0). */
export function costSatang(
  model: string,
  inputTokens: number,
  outputTokens: number,
  prices: Readonly<Record<string, ModelPrice>>,
  usdThb: number,
): number | null {
  const p = prices[model];
  if (!p) return null;
  const microUsd = inputTokens * p.in + outputTokens * p.out; // $x per 1M tokens = x micro-dollars per token
  return Math.round((microUsd * usdThb) / 10_000); // micro-USD → THB → satang
}

export type UsageRow = {
  org_id?: string | null;
  org_name?: string | null;
  task: string;
  model: string;
  source?: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
};
export type UsageLine = {
  key: string;
  task: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null = at least one model of this line has no price */
  satang: number | null;
};

/** Rows grouped by task (and organisation when given); totals add up the priced lines. */
export function summarizeUsage(
  rows: readonly UsageRow[],
  prices: Readonly<Record<string, ModelPrice>>,
  usdThb: number,
  byOrg = false,
): { lines: UsageLine[]; totalSatang: number; unpriced: boolean; calls: number } {
  const map = new Map<string, UsageLine>();
  for (const r of rows) {
    const key = byOrg ? `${r.org_name ?? ''}|${r.task}` : r.task;
    const c = costSatang(r.model, r.input_tokens, r.output_tokens, prices, usdThb);
    const cur = map.get(key) ?? {
      key: byOrg ? `${r.org_name ?? ''} · ${r.task}` : r.task,
      task: r.task,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      satang: 0,
    };
    cur.calls += r.calls;
    cur.inputTokens += r.input_tokens;
    cur.outputTokens += r.output_tokens;
    cur.satang = cur.satang === null || c === null ? null : cur.satang + c;
    map.set(key, cur);
  }
  const lines = [...map.values()];
  return {
    lines,
    totalSatang: lines.reduce((a, l) => a + (l.satang ?? 0), 0),
    unpriced: lines.some((l) => l.satang === null),
    calls: lines.reduce((a, l) => a + l.calls, 0),
  };
}
