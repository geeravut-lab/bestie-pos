import { describe, expect, it } from 'vitest';
import {
  briefFigures,
  daysToExpiry,
  groupSuggestions,
  orderLineCost,
  minutesToAnswer,
  parseBatches,
  parseCases,
  parseForecast,
  parseInsights,
  parseWaste,
  reconcile,
} from './smartOps';

describe('forecast', () => {
  const rows = parseForecast([
    {
      item_id: 'a',
      name: { th: 'นม', en: 'Milk' },
      unit: 'ml',
      quantity: 850,
      low_at: 0,
      avg_daily: 300,
      days_left: 2.8,
      on_order: 0,
      forecast: 2700,
      suggested: 1850,
      supplier_id: 's1',
      supplier_name: 'Dairy',
      last_cost: 6000,
    },
    {
      item_id: 'b',
      name: { th: 'ไข่' },
      unit: 'pcs',
      quantity: 5,
      low_at: 0,
      avg_daily: 20,
      days_left: 0.2,
      on_order: 0,
      forecast: 180,
      suggested: 175,
      supplier_id: null,
      last_cost: 4000,
    },
    {
      item_id: 'c',
      name: { th: 'เกลือ' },
      unit: 'g',
      quantity: 9000,
      low_at: 0,
      avg_daily: 1,
      days_left: null,
      on_order: 0,
      forecast: 9,
      suggested: 0,
      supplier_id: 's1',
      last_cost: 100,
    },
    { nope: 1 },
  ]);
  it('reads rows and skips damaged ones', () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ unit: 'ml', daysLeft: 2.8, supplierName: 'Dairy' });
    expect(rows[2]!.daysLeft).toBeNull();
  });
  it('groups what to buy by supplier, and sets aside items without a supplier or with nothing to buy', () => {
    const g = groupSuggestions(rows);
    expect(g.bySupplier).toEqual([
      {
        supplierId: 's1',
        supplierName: 'Dairy',
        lines: [{ item_id: 'a', quantity: 1850, cost_per_1000: 6000 }],
      },
    ]);
    expect(g.noSupplier.map((r) => r.itemId)).toEqual(['b']);
  });
  it('costs a line per 1,000 units', () => {
    expect(orderLineCost(1850, 6000)).toBe(11100);
  });
});

describe('waste and lots', () => {
  it('reads the waste report and maps an unknown reason to "other"', () => {
    const w = parseWaste({
      total: 1200,
      by_reason: [
        { reason: 'expired', cost: 800, qty: 1 },
        { reason: 'weird', cost: 400, qty: 1 },
      ],
      by_item: [{ item_id: 'a', name: { th: 'นม' }, unit: 'ml', qty: 150, cost: 1200 }],
    });
    expect(w.total).toBe(1200);
    expect(w.byReason.map((r) => r.reason)).toEqual(['expired', 'other']);
  });
  it('lists open lots by expiry date and counts days', () => {
    const b = parseBatches([
      { id: '2', item_id: 'a', qty: 5, expires_on: '2026-12-05' },
      { id: '1', item_id: 'a', qty: 5, expires_on: '2026-11-25' },
      { id: '3', item_id: 'a', qty: 1, expires_on: '2026-11-20', used_at: '2026-11-21T00:00:00Z' },
    ]);
    expect(b.map((x) => x.id)).toEqual(['1', '2']);
    expect(daysToExpiry('2026-11-25', '2026-11-22')).toBe(3);
    expect(daysToExpiry('2026-11-20', '2026-11-22')).toBe(-2);
  });
});

describe('service cases', () => {
  const [c] = parseCases([
    {
      id: 'c',
      source: 'feedback',
      summary: '1/5 cold',
      status: 'open',
      sla_min: 15,
      created_at: '2026-11-22T10:00:00Z',
    },
  ]);
  it('counts the minutes left to answer, and stops counting once answered', () => {
    const t0 = Date.parse('2026-11-22T10:10:00Z');
    expect(minutesToAnswer(c!, t0)).toBe(5);
    expect(minutesToAnswer(c!, Date.parse('2026-11-22T10:20:00Z'))).toBe(-5);
    expect(minutesToAnswer({ ...c!, firstResponseAt: '2026-11-22T10:02:00Z' }, t0)).toBeNull();
    expect(minutesToAnswer({ ...c!, status: 'resolved' }, t0)).toBeNull();
  });
});

describe('business manager', () => {
  const ins = parseInsights({
    insights: [
      {
        id: '1',
        kind: 'low_stock',
        severity: 'act',
        evidence: { items: [{ name: { th: 'นม' }, days_left: 2.8, suggested: 1850 }] },
        action: { type: 'draft_po' },
        status: 'new',
        created_at: 'x',
      },
      {
        id: '2',
        kind: 'sales_drop',
        severity: 'watch',
        evidence: { yesterday: 1000, usual: 5000 },
        status: 'dismissed',
      },
      { id: '3', kind: 'unknown_kind', evidence: {} },
    ],
  });
  it('keeps only known kinds', () => expect(ins.map((i) => i.id)).toEqual(['1', '2']));
  it('lists the figures of the open findings only (what the brief may quote)', () => {
    expect(briefFigures(ins).sort()).toEqual(['1850', '2.8']);
  });
});

describe('reconciliation', () => {
  const bestie = [
    {
      provider: 'stripe',
      providerRef: 'pi_1',
      amount: 10000,
      status: 'succeeded',
      orderNumber: 'A001',
      createdAt: '',
    },
    {
      provider: 'stripe',
      providerRef: 'pi_2',
      amount: 5000,
      status: 'succeeded',
      orderNumber: 'A002',
      createdAt: '',
    },
    {
      provider: 'stripe',
      providerRef: 'pi_3',
      amount: 7000,
      status: 'succeeded',
      orderNumber: 'A003',
      createdAt: '',
    },
    {
      provider: 'stripe',
      providerRef: 'pi_4',
      amount: 900,
      status: 'needs_review',
      orderNumber: 'A004',
      createdAt: '',
    },
    {
      provider: 'stripe',
      providerRef: 'pi_5',
      amount: 100,
      status: 'canceled',
      orderNumber: 'A005',
      createdAt: '',
    },
  ];
  const provider = [
    { providerRef: 'pi_1', amount: 10000, currency: 'thb', createdMs: 0 },
    { providerRef: 'pi_2', amount: 4000, currency: 'thb', createdMs: 0 },
    { providerRef: 'pi_4', amount: 900, currency: 'thb', createdMs: 0 },
    { providerRef: 'pi_9', amount: 300, currency: 'thb', createdMs: 0 },
  ];
  it('finds each kind of difference and does not report a payment Bestie itself parked for review as missing', () => {
    const r = reconcile(bestie, provider);
    expect(r.matched).toBe(1);
    expect(r.amountDiffers.map((d) => d.bestie.providerRef)).toEqual(['pi_2']);
    expect(r.missingAtProvider.map((b) => b.providerRef)).toEqual(['pi_3']);
    expect(r.missingInBestie.map((p) => p.providerRef)).toEqual(['pi_9']);
    expect(r.needsReview.map((b) => b.providerRef)).toEqual(['pi_4']);
    expect(r.providerTotal).toBe(15200);
    expect(r.bestieTotal).toBe(22000);
  });
  it('everything agrees', () => {
    const r = reconcile([bestie[0]!], [provider[0]!]);
    expect(r).toMatchObject({
      matched: 1,
      missingInBestie: [],
      missingAtProvider: [],
      amountDiffers: [],
    });
  });
});
