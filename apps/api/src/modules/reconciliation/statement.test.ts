import { describe, expect, it } from 'vitest';
import { parseCsv } from '../menu/import';
import { findUtr, parseAmount, parseBankDate, parseStatement } from './statement';

describe('bank statement parsing', () => {
  it('reads the date formats Indian banks use, day first', () => {
    expect(parseBankDate('15/10/2026')).toBe('2026-10-15');
    expect(parseBankDate('5-10-26')).toBe('2026-10-05');
    expect(parseBankDate('15 Oct 2026')).toBe('2026-10-15');
    expect(parseBankDate('15-OCT-2026')).toBe('2026-10-15');
    expect(parseBankDate('15-Sept-2026')).toBe('2026-09-15');
    expect(parseBankDate('2026-10-15 13:42:10')).toBe('2026-10-15');
    expect(parseBankDate('31/02/2026')).toBeNull();
    expect(parseBankDate('Opening Balance')).toBeNull();
  });

  it('reads amounts exactly', () => {
    expect(parseAmount('1,23,456.70')).toBe(12345670);
    expect(parseAmount('₹ 500')).toBe(50000);
    expect(parseAmount('987.5 Cr')).toBe(98750);
    expect(parseAmount('0.1')).toBe(10);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('(250.00)')).toBe(-25000);
    expect(Number.isNaN(parseAmount('abc'))).toBe(true);
  });

  it('finds the 12-digit UPI reference but not phone or account numbers', () => {
    expect(findUtr(null, 'UPI/CR/412345678901/RAHUL S/HDFC/rahul@okhdfc/Payment')).toBe('412345678901');
    expect(findUtr('0000412345678901', 'UPI-RAHUL-9876543210@ybl-YESB0000001-512345678902-PAY')).toBe('512345678902');
    expect(findUtr('9876543210', 'NEFT CR 50100123456789')).toBeNull();
  });

  it('HDFC: account details above the header, separate withdrawal and deposit columns', () => {
    const csv = [
      'HDFC BANK Ltd.,,,,,,',
      'Account No :50100123456789,,,,,,',
      'Statement From : 14/10/2026 To : 15/10/2026,,,,,,',
      ',,,,,,',
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '14/10/26,UPI-ANANYA RAO-ananya@okaxis-UTIB0000001-412345678901-PAYMENT,0000412345678901,14/10/26,,987.00,"10,987.00"',
      '14/10/26,ATM WDL MG ROAD,000000123456,14/10/26,"2,000.00",,"8,987.00"',
      '15/10/26,CASH DEPOSIT BY SELF,,15/10/26,,"5,000.00","13,987.00"',
      ',,,,,,',
      'STATEMENT SUMMARY :-,,,,,,',
    ].join('\n');
    const s = parseStatement(parseCsv(csv));
    expect(s.period_from).toBe('2026-10-14');
    expect(s.period_to).toBe('2026-10-15');
    expect(s.debits_skipped).toBe(1);
    expect(s.credits).toEqual([
      { txn_date: '2026-10-14', amount_paise: 98700, narration: expect.stringContaining('ANANYA'), reference: '0000412345678901', utr: '412345678901', is_upi: true },
      { txn_date: '2026-10-15', amount_paise: 500000, narration: 'CASH DEPOSIT BY SELF', reference: null, utr: null, is_upi: false },
    ]);
  });

  it('ICICI: transaction date and value date, amounts with (INR)', () => {
    const csv = [
      'S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )',
      '1,15/10/2026,14/10/2026,-,UPI/412345678911/Payment from Vikram/vikram@icici/ICICI Bank,0.0,"1,470.00","25,470.00"',
    ].join('\n');
    const [c] = parseStatement(parseCsv(csv)).credits;
    expect(c).toMatchObject({ txn_date: '2026-10-14', amount_paise: 147000, utr: '412345678911', is_upi: true });
  });

  it('SBI: day month-name year dates with Debit and Credit', () => {
    const csv = ['Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance', '15 Oct 2026,15 Oct 2026,BY TRANSFER-UPI/CR/512345678912/FATIMA/SBIN/fatima@oksbi/UPI--,TRANSFER FROM 512345678912,,640.00,"1,00,640.00"'].join('\n');
    expect(parseStatement(parseCsv(csv)).credits[0]).toMatchObject({ txn_date: '2026-10-15', amount_paise: 64000, utr: '512345678912' });
  });

  it('Kotak: one amount column with a Dr / Cr marker', () => {
    const csv = [
      'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance,Dr / Cr',
      '1,15-10-2026,15-10-2026,UPI/RAVI/612345678913/Dinner,UPI-612345678913,"1,040.00",CR,"5,040.00",CR',
      '2,15-10-2026,15-10-2026,Vendor payment,NEFT-1,"3,000.00",DR,"2,040.00",CR',
    ].join('\n');
    const s = parseStatement(parseCsv(csv));
    expect(s.credits).toHaveLength(1);
    expect(s.credits[0]).toMatchObject({ amount_paise: 104000, utr: '612345678913', is_upi: true });
    expect(s.debits_skipped).toBe(1);
  });

  it('refuses a file it cannot understand', () => {
    expect(() => parseStatement(parseCsv('name,phone\nRavi,98765'))).toThrow(/date and credit columns/);
    expect(() => parseStatement(parseCsv('Date,Narration,Withdrawal,Deposit\n15/10/2026,Rent,5000,'))).toThrow(/no money coming in/);
  });
});
