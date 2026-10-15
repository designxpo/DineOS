// Documents sent to the on-site print agent (and rendered as HTML for browser printing).
import type { InvoiceDTO } from './dto';
import type { OrderType } from './enums';

export interface KotDoc {
  kind: 'kot';
  outlet_name: string;
  kot_no: number;
  order_no: number;
  station: string;
  table_label: string | null;
  order_type: OrderType;
  placed_at: string;
  items: { name: string; qty: number; modifiers: string[]; note: string | null; seat_no: number | null }[];
  note: string | null;
  /** A cancellation ticket tells the kitchen to stop making these items. */
  cancelled: boolean;
  reprint: boolean;
}

export interface BillDoc {
  kind: 'bill';
  invoice: InvoiceDTO;
  /** "upi://pay?..." string printed as a QR so guests can pay the outlet's own UPI ID. */
  upi_uri: string | null;
  duplicate: boolean;
}

export interface TestDoc {
  kind: 'test';
  outlet_name: string;
  target: string;
  at: string;
}

export type PrintDoc = KotDoc | BillDoc | TestDoc;

export interface PrintJobDTO {
  id: string;
  kind: PrintDoc['kind'];
  /** Station name for KOTs, 'bill' for bills. The agent maps targets to printer addresses. */
  target: string;
  doc: PrintDoc;
  status: 'queued' | 'sent' | 'printed' | 'failed';
  attempts: number;
  created_at: string;
}
