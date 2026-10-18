import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { parseCsv } from '../menu/import';
import { methodOf, parseSalesExport, parseTime } from './sales-export';

const grid = (lines: string[]) => parseCsv(lines.join('\n'));

describe('sales exports from another billing system', () => {
  it('reads payment types the way billing systems write them, guessing nothing as UPI', () => {
    expect(methodOf('Cash')).toBe('cash');
    expect(methodOf('UPI')).toBe('upi');
    expect(methodOf('Google Pay')).toBe('upi');
    expect(methodOf('PhonePe')).toBe('upi');
    expect(methodOf('Card')).toBe('card_slip');
    expect(methodOf('Credit Card')).toBe('card_slip');
    expect(methodOf('Zomato Pay')).toBe('platform');
    expect(methodOf('Online')).toBe('platform');
    expect(methodOf('Due')).toBe('other');
    expect(methodOf('Credit Sale')).toBe('other');
    expect(methodOf('Part Payment')).toBe('split');
    expect(methodOf('Coupon')).toBe('other');
    expect(methodOf('')).toBe('other');
  });

  it('reads times in the forms exports use', () => {
    expect(parseTime('21:34')).toBe('21:34');
    expect(parseTime('9:05 PM')).toBe('21:05');
    expect(parseTime('12:10 am')).toBe('00:10');
    expect(parseTime('15/10/2026 09:34 p.m.')).toBe('21:34');
    expect(parseTime('2026-10-15 21:34')).toBe('21:34');
    expect(parseTime('2026-10-15T21:34:10Z')).toBe('21:34');
    expect(parseTime('15/10/2026')).toBeNull();
    expect(parseTime('25:00')).toBeNull();
  });

  it('a bill-wise report: report details above the header, cancelled bills and totals left out', () => {
    const parsed = parseSalesExport(
      grid([
        'Order Report,,,,,,,',
        'Restaurant: Chai Point Koramangala,,,,,,,',
        'From 14/10/2026 To 15/10/2026,,,,,,,',
        ',,,,,,,',
        'Invoice No.,Date,Payment Type,Order Type,Status,Sub Total,Grand Total,Payment Ref',
        '1041,14/10/2026 13:05,Cash,Dine In,Success,400.00,420.00,',
        '1042,14/10/2026 21:52,UPI,Dine In,Success,"1,000.00","1,050.00",412345678901',
        '1043,14/10/2026 22:10,Card,Pick Up,Cancelled,200.00,210.00,',
        '1044,15/10/2026 12:30 PM,Zomato,Delivery,Success,300.00,315.00,',
        '1045,15/10/2026 13:00,Complimentary,Dine In,Success,0,0,',
        'Total,,,,,"1,900.00","1,995.00",',
      ]),
    );
    expect(parsed.columns).toEqual({ date: 'Date', total: 'Grand Total', method: 'Payment Type', bill_no: 'Invoice No.', reference: 'Payment Ref', status: 'Status' });
    expect(parsed).toMatchObject({ period_from: '2026-10-14', period_to: '2026-10-15', skipped: 3, unsplit: 0 });
    expect(parsed.bills).toEqual([
      { bill_no: '1041', business_date: '2026-10-14', time: '13:05', total_paise: 42000, payments: [{ method: 'cash', amount_paise: 42000, reference: null }] },
      { bill_no: '1042', business_date: '2026-10-14', time: '21:52', total_paise: 105000, payments: [{ method: 'upi', amount_paise: 105000, reference: '412345678901' }] },
      { bill_no: '1044', business_date: '2026-10-15', time: '12:30', total_paise: 31500, payments: [{ method: 'platform', amount_paise: 31500, reference: null }] },
    ]);
  });

  it('a column per method for bills paid in parts; what no column covers counts as other', () => {
    const parsed = parseSalesExport(
      grid([
        'Bill No,Bill Date,Time,Cash,Card,UPI,Total',
        'A-7,2026-10-14,20:15,200,,300,500',
        'A-8,2026-10-14,20:40,,,250,260',
        'A-9,2026-10-14,21:00,1000,,,600',
      ]),
    );
    expect(parsed.bills.map((b) => [b.bill_no, b.total_paise, b.payments.map((p) => `${p.method}:${p.amount_paise}`)])).toEqual([
      ['A-7', 50000, ['cash:20000', 'upi:30000']],
      ['A-8', 26000, ['upi:25000', 'other:1000']],
      // Cash tendered above the total: the bill is what was paid.
      ['A-9', 100000, ['cash:100000']],
    ]);
  });

  it('one bill listed once per payment is one bill; two UPI payments stay two', () => {
    const parsed = parseSalesExport(
      grid([
        'Order No,Order Date,Payment Mode,Amount,UTR',
        '88,14/10/2026,UPI,300,512345678902',
        '88,14/10/2026,UPI,200,612345678903',
        '88,14/10/2026,Cash,100,',
        '89,14/10/2026,Part Payment,700,',
      ]),
    );
    expect(parsed.bills).toHaveLength(2);
    expect(parsed.bills[0]).toMatchObject({ bill_no: '88', total_paise: 60000 });
    expect(parsed.bills[0]!.payments).toEqual([
      { method: 'upi', amount_paise: 30000, reference: '512345678902' },
      { method: 'upi', amount_paise: 20000, reference: '612345678903' },
      { method: 'cash', amount_paise: 10000, reference: null },
    ]);
    expect(parsed.unsplit).toBe(1);
    expect(parsed.bills[1]!.payments).toEqual([{ method: 'other', amount_paise: 70000, reference: null }]);
  });

  it('asks which columns to read when the names give nothing away, then reads the ones named', () => {
    const odd = grid(['Ref,Day,Mode,Rs', 'X1,14/10/2026,UPI,99.50', 'X2,15/10/2026,Cash,120']);
    let err: unknown;
    try {
      parseSalesExport(odd);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'unknown_sales_export', details: { headers: ['Ref', 'Day', 'Mode', 'Rs'] } });

    const parsed = parseSalesExport(odd, { date: 'Day', total: 'Rs', method: 'Mode', bill_no: 'Ref' });
    expect(parsed.bills.map((b) => [b.bill_no, b.business_date, b.payments[0]!.method, b.total_paise])).toEqual([
      ['X1', '2026-10-14', 'upi', 9950],
      ['X2', '2026-10-15', 'cash', 12000],
    ]);
    expect(() => parseSalesExport(odd, { date: 'Day', total: 'Amount' })).toThrow('There is no column called "Amount"');
  });

  it('refuses a file with no paid bills in it', () => {
    expect(() => parseSalesExport(grid(['Bill No,Date,Total', '1,14/10/2026,0', 'Total,,0']))).toThrow('The file has no paid bills');
  });
});
