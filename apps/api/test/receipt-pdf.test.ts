import { describe, expect, it } from 'vitest';
import type { InvoiceDTO } from '@mezmitra/shared/dto';
import { receiptPdf } from '../src/modules/billing/customer-receipts';

const line = (i: number) => {
  const gross = 25000 + i * 100;
  const half = Math.round((gross * 5) / 200);
  return { id: String(i), order_item_id: null, name: `Dish number ${i}`, qty: 1, unit_price_paise: gross, gross_paise: gross, item_discount_paise: 0, bill_discount_paise: 0, taxable_paise: gross, tax_rate_bp: 500, cgst_paise: half, sgst_paise: half, amount_paise: gross + 2 * half, hsn_sac: '996331', seat_no: null, comp_qty: 0, comp_paise: 0, comps: [] };
};

function invoice(count: number): InvoiceDTO {
  const lines = Array.from({ length: count }, (_, i) => line(i + 1));
  const subtotal = lines.reduce((a, l) => a + l.gross_paise, 0);
  const cgst = lines.reduce((a, l) => a + l.cgst_paise, 0);
  return {
    outlet: { name: 'The Courtyard', legal_name: 'Aurum Hospitality Pvt Ltd', address: '14 MG Road, Bengaluru', gstin: '29AABCA1234D1Z5', fssai_no: '11226999000123', phone: '+91 80 4000 1234', state_code: '29' },
    tax_summary: [{ tax_rate_bp: 500, taxable_paise: subtotal, cgst_paise: cgst, sgst_paise: cgst }],
    bill: { invoice_no: 'AGC/2627/000143', invoice_date: '2026-10-19', table_label: 'C5', lines, subtotal_paise: subtotal, total_paise: subtotal + 2 * cgst, balance_paise: 0, payments: [], comp_paise: 0, item_discount_paise: 0, bill_discount_paise: 0, member_discount_paise: 0, loyalty_discount_paise: 0, reward_discount_paise: 0, service_charge_paise: 0, round_off_paise: 0 },
  } as unknown as InvoiceDTO;
}

const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('invoice PDF', () => {
  it('fits a short bill on one page and runs a long one over several, with totals on the last', async () => {
    const short = await receiptPdf(invoice(3));
    expect(short.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(short)).toBe(1);
    const long = await receiptPdf(invoice(90));
    expect(pages(long)).toBeGreaterThan(2);
  });
});
