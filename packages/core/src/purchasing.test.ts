import { describe, expect, it } from 'vitest';
import {
  parsePurchaseOrders,
  parseSuppliers,
  parseTransfers,
  poActions,
  poOutstanding,
  poTotal,
  transferActions,
} from './purchasing';

const line = (ordered: number, received: number, cost = 1000) => ({
  id: 'l',
  itemId: 'i',
  ordered,
  received,
  costPer1000: cost,
});

describe('purchase orders', () => {
  it('totals at the agreed price (satang per 1,000 base units)', () => {
    expect(poTotal([line(10000, 0, 6500), line(2500, 0, 4000)])).toBe(65000 + 10000);
  });
  it('outstanding goods never go below zero', () => {
    expect(poOutstanding(line(100, 40))).toBe(60);
    expect(poOutstanding(line(100, 130))).toBe(0);
  });
  it('allows what the database allows in each state', () => {
    const o = (status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled', r = 0) => ({
      status,
      lines: [line(10, r)],
    });
    expect(poActions(o('draft'))).toEqual({ edit: true, send: true, receive: true, cancel: true });
    expect(poActions(o('sent'))).toEqual({ edit: false, send: false, receive: true, cancel: true });
    expect(poActions(o('partial', 5))).toEqual({
      edit: false,
      send: false,
      receive: true,
      cancel: false,
    });
    expect(poActions(o('received', 10))).toEqual({
      edit: false,
      send: false,
      receive: false,
      cancel: false,
    });
    expect(poActions(o('cancelled')).receive).toBe(false);
  });
  it('parses orders with their lines and drops broken rows', () => {
    const r = parsePurchaseOrders(
      [
        { id: 'p1', number: 'PO-0001', supplier_id: 's1', status: 'sent', created_at: 'x' },
        { id: 'p2', number: 'PO-0002', status: 'weird' },
      ],
      [
        {
          id: 'a',
          po_id: 'p1',
          item_id: 'i',
          qty_ordered: '500',
          qty_received: 0,
          cost_per_1000: 3000,
        },
        { id: 'b', po_id: 'other', item_id: 'i' },
        { nope: true },
      ],
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.lines).toEqual([
      { id: 'a', itemId: 'i', ordered: 500, received: 0, costPer1000: 3000 },
    ]);
  });
});

describe('transfers and suppliers', () => {
  it('only the receiving side receives; either side can call a sent transfer off', () => {
    expect(transferActions({ status: 'sent' }, 'to')).toEqual({ receive: true, cancel: true });
    expect(transferActions({ status: 'sent' }, 'from')).toEqual({ receive: false, cancel: true });
    expect(transferActions({ status: 'received' }, 'to')).toEqual({
      receive: false,
      cancel: false,
    });
  });
  it('parses transfers with their lines', () => {
    const r = parseTransfers(
      [
        {
          id: 't',
          number: 'TR-0001',
          from_store_id: 'a',
          to_store_id: 'b',
          status: 'sent',
          created_at: 'x',
        },
      ],
      [{ id: 'l', transfer_id: 't', from_item_id: 'i', quantity: 3000, cost_per_1000: 6500 }],
    );
    expect(r[0]).toMatchObject({ number: 'TR-0001', status: 'sent' });
    expect(r[0]!.lines[0]).toEqual({ id: 'l', fromItemId: 'i', quantity: 3000, costPer1000: 6500 });
    expect(parseTransfers('x', [])).toEqual([]);
  });
  it('parses suppliers', () => {
    expect(parseSuppliers([{ id: '1', name: 'Makro', phone: '02', note: '' }, { id: 2 }])).toEqual([
      { id: '1', name: 'Makro', phone: '02', note: null },
    ]);
  });
});
