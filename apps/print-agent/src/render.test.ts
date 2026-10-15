import { describe, expect, it } from 'vitest';
import type { BillDoc, KotDoc } from '@dineos/shared/print';
import { columns, toAscii, wrap } from './escpos';
import { renderBill, renderKot } from './render';

const kot: KotDoc = {
  kind: 'kot',
  outlet_name: 'The Courtyard',
  kot_no: 42,
  order_no: 17,
  station: 'kitchen',
  table_label: 'T4',
  order_type: 'dine_in',
  placed_at: '2026-10-15T07:11:00Z',
  items: [
    { name: 'Paneer Tikka', qty: 2, modifiers: [], note: null, seat_no: null },
    { name: 'Cold Coffee', qty: 1, modifiers: ['Large', 'Extra shot'], note: 'less ice', seat_no: 2 },
  ],
  note: 'Birthday at this table',
  cancelled: false,
  reprint: false,
};

describe('layout helpers', () => {
  it('pads columns to the paper width', () => {
    expect(columns('Subtotal', '820.00', 20)).toBe('Subtotal      820.00');
    expect(columns('A very long item name that overflows', '9.00', 20)).toHaveLength(20);
  });
  it('wraps with a hanging indent', () => {
    expect(wrap('one two three four five', 10, '  ')).toEqual(['one two', '  three', '  four', '  five']);
  });
  it('keeps output printable on single-byte code pages', () => {
    expect(toAscii('₹250 – café')).toBe('Rs.250 - cafe');
  });
});

describe('kitchen ticket', () => {
  it('shows ticket, table, items, choices and notes', () => {
    const text = renderKot(kot, 32).preview.join('\n');
    expect(text).toContain('KOT 42');
    expect(text).toContain('KITCHEN');
    expect(text).toContain('Table T4');
    expect(text).toContain('Order #17');
    expect(text).toContain('2 x Paneer Tikka');
    expect(text).toContain('1 x Cold Coffee (seat 2)');
    expect(text).toContain('+ Large, Extra shot');
    expect(text).toContain('! less ice');
    expect(text).toContain('Note: Birthday at this table');
    expect(text.endsWith('--- cut ---')).toBe(true);
  });
  it('marks cancellations and reprints', () => {
    const text = renderKot({ ...kot, cancelled: true, reprint: true }, 32).preview.join('\n');
    expect(text).toContain('CANCELLED');
    expect(text).toContain('** REPRINT **');
  });
  it('starts with ESC @ and ends with a cut', () => {
    const bytes = renderKot(kot, 48).build();
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.subarray(-4)]).toEqual([0x1d, 0x56, 66, 0]);
  });
});

describe('bill', () => {
  const doc: BillDoc = {
    kind: 'bill',
    duplicate: false,
    upi_uri: 'upi://pay?pa=courtyard@okbank&am=903.00',
    invoice: {
      outlet: { name: 'The Courtyard', legal_name: 'Aurum Hotels Pvt Ltd', address: 'MG Road, Bengaluru', gstin: '29ABCDE1234F1Z5', fssai_no: '11223344556677', phone: null, state_code: '29' },
      tax_summary: [{ tax_rate_bp: 500, taxable_paise: 50000, cgst_paise: 1250, sgst_paise: 1250 }],
      bill: {
        id: 'b', outlet_id: 'o', table_session_id: 's', order_id: null, table_label: 'T4', parent_bill_id: null, split_label: null,
        status: 'finalised',
        lines: [{ id: 'l', order_item_id: 'i', name: 'Paneer Tikka', qty: 2, unit_price_paise: 25000, gross_paise: 50000, item_discount_paise: 0, bill_discount_paise: 0, taxable_paise: 50000, tax_rate_bp: 500, cgst_paise: 1250, sgst_paise: 1250, amount_paise: 52500, hsn_sac: '996331', seat_no: null }],
        bill_discount: null, discount_reason: null, service_charge_bp: 0, service_charge_waived: false,
        subtotal_paise: 50000, item_discount_paise: 0, bill_discount_paise: 0, service_charge_paise: 0, taxable_paise: 50000,
        cgst_paise: 1250, sgst_paise: 1250, tax_total_paise: 2500, round_off_paise: 0, total_paise: 52500, paid_paise: 0, balance_paise: 52500,
        amount_shares: null, invoice_no: 'AURM/2627/000123', invoice_date: '2026-10-15', customer_name: null, customer_gstin: null,
        payments: [], finalised_at: null, paid_at: null, voided_at: null, void_reason: null, created_at: '2026-10-15T07:00:00Z',
      },
    },
  };

  it('prints a GST tax invoice with the CGST/SGST split and a UPI QR', () => {
    const text = renderBill(doc, 42).preview.join('\n');
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('GSTIN: 29ABCDE1234F1Z5');
    expect(text).toContain('FSSAI: 11223344556677');
    expect(text).toContain('AURM/2627/000123');
    expect(text).toContain('HSN/SAC 996331');
    expect(text).toMatch(/CGST 2\.5% on 500\.00\s+12\.50/);
    expect(text).toMatch(/SGST 2\.5% on 500\.00\s+12\.50/);
    expect(text).toMatch(/TOTAL\s+Rs\. 525\.00/);
    expect(text).toContain('[QR upi://pay?pa=courtyard@okbank&am=903.00]');
    for (const line of renderBill(doc, 42).preview.filter((l) => !l.startsWith('[QR'))) expect(line.length).toBeLessThanOrEqual(42);
  });
});
