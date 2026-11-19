import { describe, expect, it } from 'vitest';
import { parsePrintJobs } from './printJobs';

describe('parsePrintJobs', () => {
  it('reads a job and drops damaged ones', () => {
    const jobs = parsePrintJobs([
      {
        id: 'a',
        station: 'kitchen',
        printer_id: 'hot',
        order_number: 'QR001',
        table_name: 'T1',
        sent_at: '2026-11-19T05:00:00Z',
        lines: [
          { quantity: 2, name_th: 'ผัดไทย', modifiers: ['ไข่ดาว', 5, ''], seat: 2, note: 'ไม่เผ็ด' },
        ],
      },
      { id: 'b', station: 'freezer', printer_id: 'hot', lines: [{ quantity: 1 }] },
      { id: 'c', station: 'bar', printer_id: 'x', lines: [] },
      'nonsense',
      { station: 'bar', printer_id: 'x', lines: [{ quantity: 1 }] },
    ]);
    expect(jobs).toEqual([
      {
        id: 'a',
        station: 'kitchen',
        printerId: 'hot',
        orderNumber: 'QR001',
        tableName: 'T1',
        sentAt: '2026-11-19T05:00:00Z',
        lines: [{ quantity: 2, nameTh: 'ผัดไทย', modifiers: ['ไข่ดาว'], seat: 2, note: 'ไม่เผ็ด' }],
      },
    ]);
    expect(parsePrintJobs(null)).toEqual([]);
  });
});
