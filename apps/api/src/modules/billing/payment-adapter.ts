// Payment confirmation seam (spec §13 Phase 4: "payment adapter interface, already stubbed in
// Phase 1"). Phase 1 has no gateway: UPI goes to the outlet's own VPA and staff confirm receipt by
// hand. A gateway or bank integration later implements this interface; billing does not change.

import type { PaymentMethod } from '@mezmitra/shared/enums';

export interface PaymentRequest {
  billId: string;
  invoiceNo: string | null;
  method: PaymentMethod;
  amountPaise: number;
  /** UTR, card slip number, room number... whatever the staff member typed. */
  reference: string | null;
}

export type PaymentConfirmation =
  | { status: 'confirmed'; reference: string | null }
  | { status: 'pending'; externalId: string }
  | { status: 'failed'; reason: string };

export interface PaymentAdapter {
  readonly name: string;
  /** Called when staff record a payment. Manual confirmation succeeds immediately. */
  confirm(request: PaymentRequest): Promise<PaymentConfirmation>;
}

/** v1: the staff member is the confirmation (they saw cash, a UPI credit, or a card slip). */
export const manualAdapter: PaymentAdapter = {
  name: 'manual',
  async confirm(request) {
    return { status: 'confirmed', reference: request.reference?.trim() || null };
  },
};

export function paymentAdapterFor(_method: PaymentMethod): PaymentAdapter {
  return manualAdapter;
}
