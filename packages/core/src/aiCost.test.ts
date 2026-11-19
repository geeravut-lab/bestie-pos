import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICES, costSatang, mergePrices, summarizeUsage } from './aiCost';

describe('costSatang', () => {
  it('Haiku 5.5: 1M input + 1M output tokens = $0.60 = THB 21.60 at 36', () => {
    expect(costSatang('claude-haiku-5-5', 1_000_000, 1_000_000, DEFAULT_MODEL_PRICES, 36)).toBe(
      2160,
    );
  });
  it('a typical guest filter call costs a fraction of a satang to a few satang', () => {
    const c = costSatang('claude-haiku-5-5', 400, 60, DEFAULT_MODEL_PRICES, 36)!;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(5);
  });
  it('an unknown model has no price (null, never 0)', () => {
    expect(costSatang('mystery', 10, 10, DEFAULT_MODEL_PRICES, 36)).toBeNull();
  });
});

describe('mergePrices', () => {
  it('overlays corrections and ignores bad entries', () => {
    const p = mergePrices({
      'claude-haiku-5-5': { in: 1, out: 5 },
      'new-model': { in: 3, out: 9 },
      bad: { in: -1, out: 2 },
      worse: 'x',
      'bad name!': { in: 1, out: 1 },
    });
    expect(p['claude-haiku-5-5']).toEqual({ in: 1, out: 5 });
    expect(p['new-model']).toEqual({ in: 3, out: 9 });
    expect(p.bad).toBeUndefined();
    expect(p.worse).toBeUndefined();
    expect(p['claude-sonnet-5-5']).toEqual({ in: 2, out: 10 });
    expect(mergePrices(null)).toEqual(DEFAULT_MODEL_PRICES);
  });
});

describe('summarizeUsage', () => {
  const rows = [
    {
      task: 'guest_menu_qa',
      model: 'claude-haiku-5-5',
      calls: 100,
      input_tokens: 40_000,
      output_tokens: 6_000,
    },
    {
      task: 'guest_menu_qa',
      model: 'gemini-flash-lite-latest',
      calls: 10,
      input_tokens: 4_000,
      output_tokens: 600,
    },
    {
      task: 'menu_tags',
      model: 'claude-haiku-5-5',
      calls: 5,
      input_tokens: 500,
      output_tokens: 200,
    },
  ];
  it('groups by task, adds calls and tokens, and totals the priced lines', () => {
    const s = summarizeUsage(rows, DEFAULT_MODEL_PRICES, 36);
    expect(s.lines.map((l) => [l.task, l.calls, l.inputTokens])).toEqual([
      ['guest_menu_qa', 110, 44_000],
      ['menu_tags', 5, 500],
    ]);
    expect(s.calls).toBe(115);
    expect(s.unpriced).toBe(false);
    expect(s.totalSatang).toBe(s.lines.reduce((a, l) => a + (l.satang ?? 0), 0));
    expect(s.totalSatang).toBeGreaterThan(0);
  });
  it('a line with an unpriced model is flagged, and not counted as free', () => {
    const s = summarizeUsage(
      [
        ...rows,
        { task: 'menu_tags', model: 'mystery', calls: 1, input_tokens: 9, output_tokens: 9 },
      ],
      DEFAULT_MODEL_PRICES,
      36,
    );
    expect(s.unpriced).toBe(true);
    expect(s.lines.find((l) => l.task === 'menu_tags')!.satang).toBeNull();
  });
  it('can group per organisation for the platform admin', () => {
    const s = summarizeUsage(
      [
        { ...rows[0]!, org_name: 'Acme' },
        { ...rows[0]!, org_name: 'Beach' },
      ],
      DEFAULT_MODEL_PRICES,
      36,
      true,
    );
    expect(s.lines).toHaveLength(2);
  });
});
