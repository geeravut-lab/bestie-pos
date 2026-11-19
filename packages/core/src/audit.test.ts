import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENTS,
  AUDIT_GROUPS,
  DEFAULT_AUDIT_SETTINGS,
  auditEventLabelKey,
  cleanAuditDetail,
  eventsInGroup,
  isCriticalAuditEvent,
  normalizeDisabled,
  setEventRecorded,
  setGroupRecorded,
  shouldRecord,
} from './audit';
import { csvCell, toCsv } from './csv';

describe('audit catalogue ↔ database seed', () => {
  const dir = join(import.meta.dirname, '../../../supabase/migrations');
  // the first migration seeds the catalogue; later ones may add event types (the cash drawer)
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('_audit_trail.sql') || f.endsWith('_drawer_open.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
    .replace(/values \('drawer\.open', 'shift', true\)/, "('drawer.open', 'shift', true)");
  const seeded = [...sql.matchAll(/\('([a-z_.]+)',\s*'([a-z]+)',\s*(true|false)\)/g)].map((m) => ({
    id: m[1]!,
    group: m[2]!,
    critical: m[3] === 'true',
  }));

  it('has exactly the same events, groups and critical flags as audit_event_types', () => {
    expect(seeded.length).toBe(AUDIT_EVENTS.length);
    expect([...seeded].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...AUDIT_EVENTS].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('every event belongs to a known group and ids are unique', () => {
    expect(new Set(AUDIT_EVENTS.map((e) => e.id)).size).toBe(AUDIT_EVENTS.length);
    for (const e of AUDIT_EVENTS) expect(AUDIT_GROUPS).toContain(e.group);
    for (const g of AUDIT_GROUPS) expect(eventsInGroup(g).length, g).toBeGreaterThan(0);
  });

  it('money, role, legal and audit-setting events are critical', () => {
    for (const id of [
      'payment.refund',
      'order.void',
      'credit.topup',
      'credit.spend',
      'credit.adjust',
      'points.adjust',
      'staff.role_change',
      'org.legal_signoff_change',
      'module.toggle',
      'audit.settings_change',
      'export.audit',
    ]) {
      expect(isCriticalAuditEvent(id), id).toBe(true);
    }
  });
});

describe('shouldRecord', () => {
  it('records everything by default', () => {
    expect(shouldRecord(undefined, 'order.discount')).toBe(true);
  });
  it('master switch off stops ordinary events but never critical ones', () => {
    const off = { enabled: false, disabledEvents: [] };
    expect(shouldRecord(off, 'order.discount')).toBe(false);
    expect(shouldRecord(off, 'payment.refund')).toBe(true);
  });
  it('unticked event types stop; others continue', () => {
    const s = { enabled: true, disabledEvents: ['order.discount'] };
    expect(shouldRecord(s, 'order.discount')).toBe(false);
    expect(shouldRecord(s, 'order.reopen')).toBe(true);
  });
  it('unknown events are never recorded', () => {
    expect(shouldRecord(undefined, 'made.up')).toBe(false);
  });
});

describe('ticking events', () => {
  it('unticks and reticks an ordinary event', () => {
    const a = setEventRecorded(DEFAULT_AUDIT_SETTINGS, 'order.discount', false);
    expect(a.disabledEvents).toEqual(['order.discount']);
    expect(setEventRecorded(a, 'order.discount', true).disabledEvents).toEqual([]);
  });
  it('refuses to untick a critical event', () => {
    expect(setEventRecorded(DEFAULT_AUDIT_SETTINGS, 'order.void', false)).toBe(
      DEFAULT_AUDIT_SETTINGS,
    );
  });
  it('unticking a group leaves its critical events recorded', () => {
    const s = setGroupRecorded(DEFAULT_AUDIT_SETTINGS, 'order', false);
    expect(s.disabledEvents).toEqual(['order.discount', 'order.price_override', 'order.reopen']);
    expect(shouldRecord(s, 'order.void')).toBe(true);
    expect(setGroupRecorded(s, 'order', true).disabledEvents).toEqual([]);
  });
  it('normalizeDisabled drops unknown and critical ids and duplicates', () => {
    expect(
      normalizeDisabled(['order.discount', 'order.discount', 'order.void', 'nope', 5]),
    ).toEqual(['order.discount']);
    expect(normalizeDisabled(null)).toEqual([]);
  });
  it('label keys follow the dictionary naming', () => {
    expect(auditEventLabelKey('order.void')).toBe('auditEvt_order_void');
  });
});

describe('cleanAuditDetail', () => {
  it('keeps ids / codes / numbers and drops PII-looking keys, objects and long values', () => {
    expect(
      cleanAuditDetail({
        customer_name: 'x',
        phone: '1',
        email: 'a',
        note: 'free',
        ok_code: 'E1',
        amount: 5000,
        nested: { a: 1 },
        long: 'x'.repeat(300),
        flag: true,
      }),
    ).toEqual({ ok_code: 'E1', amount: 5000, flag: true });
    expect(cleanAuditDetail(null)).toEqual({});
    expect(cleanAuditDetail([1])).toEqual({});
  });
});

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5'); // real numbers stay numbers
  });
  it('writes a BOM and CRLF rows', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('﻿a,b\r\n1,x\r\n');
    expect(toCsv(['a'], [], { bom: false })).toBe('a\r\n');
  });
});
