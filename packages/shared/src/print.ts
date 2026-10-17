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

/** Opens the cash drawer wired to the bill printer (a pulse, nothing printed). */
export interface DrawerDoc {
  kind: 'drawer';
}

export type PrintDoc = KotDoc | BillDoc | TestDoc | DrawerDoc;

/**
 * How the print agent reaches a printer:
 *   "192.168.1.50:9100"      a network printer (LAN or Wi-Fi), raw on port 9100
 *   "printer:EPSON TM-T82"   a printer installed on the agent's computer (usually USB), sent raw
 *                            through the Windows spooler or CUPS on macOS and Linux
 *   "/dev/usb/lp0"           a USB printer device on Linux, written directly
 */
export interface PrinterConfig {
  address: string;
  /** Characters per line: 48 for 80 mm paper, 32 for 58 mm. */
  width: 32 | 42 | 48;
  /** Bill printer only: open the cash drawer plugged into it on cash payments. */
  drawer?: boolean;
}

/** A printer the agent can see from its computer. */
export interface FoundPrinter {
  address: string;
  label: string;
  kind: 'network' | 'system' | 'device';
}

/** What a print agent reports about itself and the printers it found. */
export interface DeviceInfo {
  version?: string;
  platform?: string;
  hostname?: string;
  printers?: FoundPrinter[];
  scanned_at?: string;
}

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

/** A kitchen ticket or bill that did not print, or is still waiting for the print computer. */
export interface PrintProblemDTO {
  job_id: string;
  kind: 'kot' | 'bill' | 'test';
  target: string;
  /** "KOT 12 · Table C4", "Bill AGC/2627/000135" */
  label: string;
  /** The order of a kitchen ticket, for printing it from the browser instead. */
  order_id: string | null;
  bill_id: string | null;
  status: 'failed' | 'waiting';
  since: string;
  error: string | null;
}

export interface PrintStatusDTO {
  /** The outlet's print computers; none means printing is not set up (screens are the tickets). */
  agents: { id: string; name: string; online: boolean; last_seen_at: string | null }[];
  problems: PrintProblemDTO[];
}
