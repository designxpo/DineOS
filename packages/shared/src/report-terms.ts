// What each figure in the reports means, in plain words: shown next to the figure on screen and
// printed on the "Read me" sheet of the month-end pack, so the owner and the accountant read the
// same definitions.

export interface ReportTerm {
  label: string;
  means: string;
}

export const REPORT_TERMS = {
  net_sales: {
    label: 'Net sales',
    means: 'What guests were billed, including GST and service charge, after discounts and free items. Bills that are finalised or paid, by invoice date. Voided bills are left out. Paid memberships sold count here too.',
  },
  bills: { label: 'Bills', means: 'Invoices raised in the period, not counting voided ones.' },
  average_bill: { label: 'Average bill', means: 'Net sales divided by the number of bills.' },
  gross: { label: 'Gross (menu prices)', means: 'Menu price times quantity of everything billed, before any discount or free item.' },
  given_free: { label: 'Given free', means: 'Menu value of dishes given free (complimentary). Not a sale, and counted apart from discounts.' },
  discounts: {
    label: 'Discounts',
    means: 'Money taken off bills: dish and bill discounts, plus loyalty points, rewards and member discounts. Free dishes are not included; they are under "Given free".',
  },
  service_charge: { label: 'Service charge', means: 'Service charge added to bills, before its GST.' },
  taxable: { label: 'Taxable value', means: 'The value GST is charged on: gross, less discounts and free dishes, plus service charge. When menu prices include GST, the GST is taken out first.' },
  gst: {
    label: 'GST collected',
    means: 'CGST plus SGST on your bills. Orders on which a delivery app pays the GST (section 9(5)) are not included; they are listed apart.',
  },
  round_off: { label: 'Round off', means: 'The paise added to or taken off each bill to round it to the rupee.' },
  still_unpaid: { label: 'Still unpaid', means: 'Billed in the period but not yet paid in full, as of now.' },
  voids: {
    label: 'Voided bills',
    means: 'Bills cancelled after the invoice number was given, counted on the day they were voided. The invoice number stays used, so the series has no gaps.',
  },
  payments: {
    label: 'Payments',
    means: 'Money received, by the day it was received (not the bill date), less refunds. A bill from last night paid this morning counts today.',
  },
  wallet_topups: {
    label: 'Wallet top-ups',
    means: 'Money guests paid into their prepaid wallet. Not a sale and has no invoice: the GST is on the bill when the wallet is spent.',
  },
  refunds: { label: 'Refunds', means: 'Money given back on a paid bill, on the day it was given back.' },
  free_cost: { label: 'Cost to you', means: 'Ingredient cost of the free dishes, from your recipes. Dishes without a recipe count as nothing.' },
  open_bills: { label: 'Open bills', means: 'Bills with an invoice that are not yet paid in full, as of now, whatever day they were raised.' },
  expected_cash: { label: 'Cash in the drawer', means: 'Cash received for bills plus cash paid into wallets, less cash refunds. Count the drawer against this.' },
  guests: { label: 'Guests', means: 'Guests seated, from the number entered when each table was opened.' },
  hsn: { label: 'HSN/SAC summary', means: 'Quantity and taxable value per HSN/SAC code and rate, for the HSN summary in GSTR-1.' },
  b2b: { label: 'Business (B2B) invoices', means: 'Invoices to a buyer who gave a GSTIN. They are reported invoice by invoice in GSTR-1.' },
  operator: {
    label: 'Sold through delivery apps',
    means: 'Zomato and Swiggy orders on which the app pays the GST (section 9(5)). Your invoice shows no GST; report them apart in GSTR-1.',
  },
  dish_revenue: {
    label: 'Dish revenue',
    means: 'Menu price times quantity for dishes cooked in the period, by the day they were ordered. Before discounts and GST, so it will not match net sales.',
  },
} as const satisfies Record<string, ReportTerm>;

export type ReportTermKey = keyof typeof REPORT_TERMS;

/** How the dates work, for the month-end pack. */
export const REPORT_DATE_RULES: readonly string[] = [
  'Sales, GST, invoices and discounts follow the invoice date.',
  'Payments, refunds and wallet top-ups follow the day the money moved.',
  'Voids follow the day the bill was voided.',
  'Dish sales and free items follow the day the order was placed, so they include dishes on bills not yet invoiced.',
  'All money is in rupees. All times are in the outlet\'s time zone.',
];
