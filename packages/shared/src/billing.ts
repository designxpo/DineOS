// Bill arithmetic. Everything is integer paise; rates are basis points (500 = 5%).
// Pure functions so the POS can preview exactly what the server will charge.

export interface BillLineInput {
  key: string;
  qty: number;
  /** Price of one unit including modifiers, as listed on the menu. */
  unit_price_paise: number;
  tax_rate_bp: number;
  /** Absolute discount for the whole line. */
  item_discount_paise?: number;
}

export type BillDiscount = { kind: 'percent'; bp: number } | { kind: 'amount'; paise: number };

export interface BillInput {
  lines: readonly BillLineInput[];
  bill_discount?: BillDiscount | null;
  /** Loyalty points redeemed, as money. Applied after the bill discount, capped at what is left. */
  loyalty_paise?: number;
  /** 0 when the outlet has no service charge or staff removed it. */
  service_charge_bp: number;
  service_charge_tax_rate_bp: number;
  /** When true, menu prices already include GST and tax is backed out. */
  prices_include_tax: boolean;
}

export interface BillLineResult {
  key: string;
  qty: number;
  unit_price_paise: number;
  gross_paise: number;
  item_discount_paise: number;
  bill_discount_paise: number;
  taxable_paise: number;
  tax_rate_bp: number;
  cgst_paise: number;
  sgst_paise: number;
  tax_paise: number;
  amount_paise: number;
}

export interface BillTotals {
  lines: BillLineResult[];
  subtotal_paise: number;
  item_discount_paise: number;
  bill_discount_paise: number;
  loyalty_discount_paise: number;
  service_charge_paise: number;
  service_charge_tax_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  tax_total_paise: number;
  round_off_paise: number;
  total_paise: number;
}

/** Splits `total` across `weights` so the parts sum exactly (largest remainder method). */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    parts[i]! += 1;
    rest -= 1;
  }
  return parts;
}

/** Equal shares of `total` across `n` people; the first shares absorb the odd paise. */
export function splitEvenly(total: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a positive integer');
  return allocate(total, Array.from({ length: n }, () => 1));
}

function halfTax(taxable: number, rateBp: number): number {
  return Math.round((taxable * rateBp) / 2 / 10000);
}

export function computeBill(input: BillInput): BillTotals {
  const prepared = input.lines.map((l) => {
    const gross = l.qty * l.unit_price_paise;
    const itemDiscount = Math.min(Math.max(l.item_discount_paise ?? 0, 0), gross);
    return { line: l, gross, itemDiscount, afterItem: gross - itemDiscount };
  });

  const discountable = prepared.reduce((a, p) => a + p.afterItem, 0);
  let billDiscount = 0;
  const d = input.bill_discount;
  if (d?.kind === 'percent') billDiscount = Math.round((discountable * Math.min(d.bp, 10000)) / 10000);
  else if (d?.kind === 'amount') billDiscount = Math.min(Math.max(d.paise, 0), discountable);
  // Loyalty redemption is a discount at the time of sale, so it also reduces the taxable value.
  const loyalty = Math.min(Math.max(input.loyalty_paise ?? 0, 0), discountable - billDiscount);
  const shares = allocate(
    billDiscount + loyalty,
    prepared.map((p) => p.afterItem),
  );

  const lines: BillLineResult[] = prepared.map((p, i) => {
    const value = p.afterItem - shares[i]!;
    const rate = p.line.tax_rate_bp;
    let taxable: number;
    let cgst: number;
    let sgst: number;
    if (input.prices_include_tax) {
      taxable = Math.round((value * 10000) / (10000 + rate));
      const tax = value - taxable;
      cgst = Math.round(tax / 2);
      sgst = tax - cgst;
    } else {
      taxable = value;
      cgst = halfTax(taxable, rate);
      sgst = cgst;
    }
    return {
      key: p.line.key,
      qty: p.line.qty,
      unit_price_paise: p.line.unit_price_paise,
      gross_paise: p.gross,
      item_discount_paise: p.itemDiscount,
      bill_discount_paise: shares[i]!,
      taxable_paise: taxable,
      tax_rate_bp: rate,
      cgst_paise: cgst,
      sgst_paise: sgst,
      tax_paise: cgst + sgst,
      amount_paise: taxable + cgst + sgst,
    };
  });

  const linesTaxable = lines.reduce((a, l) => a + l.taxable_paise, 0);
  const serviceCharge = Math.round((linesTaxable * Math.max(input.service_charge_bp, 0)) / 10000);
  const scHalf = halfTax(serviceCharge, input.service_charge_tax_rate_bp);

  const cgst = lines.reduce((a, l) => a + l.cgst_paise, 0) + scHalf;
  const sgst = lines.reduce((a, l) => a + l.sgst_paise, 0) + scHalf;
  const taxable = linesTaxable + serviceCharge;
  const exact = taxable + cgst + sgst;
  const total = Math.round(exact / 100) * 100;

  return {
    lines,
    subtotal_paise: prepared.reduce((a, p) => a + p.gross, 0),
    item_discount_paise: prepared.reduce((a, p) => a + p.itemDiscount, 0),
    bill_discount_paise: billDiscount,
    loyalty_discount_paise: loyalty,
    service_charge_paise: serviceCharge,
    service_charge_tax_paise: scHalf * 2,
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    tax_total_paise: cgst + sgst,
    round_off_paise: total - exact,
    total_paise: total,
  };
}
