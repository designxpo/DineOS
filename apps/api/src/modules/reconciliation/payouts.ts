// Delivery payouts: the app's statement for a cycle set beside what the outlet billed and what the
// bank received, so the owner can see where the money went and take a shortfall up with the app.

import type { ChannelPayoutDTO, PayoutLineKind } from '@mezmitra/shared/dto';
import type { DeliveryChannel } from '@mezmitra/shared/enums';
import type { Tx } from '../../context';
import { deliveryReport } from '../reports/service';

type Row = {
  id: string;
  outlet_id: string;
  channel: string;
  period_from: string;
  period_to: string;
  reference: string | null;
  orders_claimed: number;
  gross_paise: number;
  net_paise: number;
  bank_credit_id: string | null;
  dispute_status: string | null;
  dispute_note: string | null;
  recovered_paise: number;
};

const COLUMNS = ['id', 'outlet_id', 'channel', 'period_from', 'period_to', 'reference', 'orders_claimed', 'gross_paise', 'net_paise', 'bank_credit_id', 'dispute_status', 'dispute_note', 'recovered_paise'] as const;

/** Builds the comparison for payouts of one outlet (all, or just `id`). */
export async function payoutViews(tx: Tx, outlet: { id: string; timezone: string }, only?: string): Promise<ChannelPayoutDTO[]> {
  let q = tx.db.selectFrom('channel_payouts').select(COLUMNS).where('outlet_id', '=', outlet.id);
  if (only) q = q.where('id', '=', only);
  const rows: Row[] = await q.orderBy('period_to', 'desc').orderBy('channel').execute();
  if (!rows.length) return [];
  const lines = await tx.db
    .selectFrom('channel_payout_lines')
    .select(['id', 'payout_id', 'kind', 'amount_paise', 'note'])
    .where('payout_id', 'in', rows.map((r) => r.id))
    .orderBy('created_at')
    .execute();
  const credits = await tx.db
    .selectFrom('bank_credits')
    .select(['id', 'txn_date', 'amount_paise'])
    .where('id', 'in', rows.map((r) => r.bank_credit_id).filter((x): x is string => !!x))
    .execute();

  const out: ChannelPayoutDTO[] = [];
  for (const r of rows) {
    const books = (await deliveryReport(tx, { outletId: outlet.id, from: r.period_from, to: r.period_to, timezone: outlet.timezone })).channels.find((c) => c.channel === (r.channel as DeliveryChannel));
    const mine = lines.filter((l) => l.payout_id === r.id);
    const deductions = mine.reduce((a, l) => a + l.amount_paise, 0);
    const credit = credits.find((c) => c.id === r.bank_credit_id);
    const expected = books?.payout_paise ?? 0;
    out.push({
      id: r.id,
      channel: r.channel as 'zomato' | 'swiggy',
      period_from: r.period_from,
      period_to: r.period_to,
      reference: r.reference,
      orders_claimed: r.orders_claimed,
      gross_paise: r.gross_paise,
      net_paise: r.net_paise,
      lines: mine.map((l) => ({ id: l.id, kind: l.kind as PayoutLineKind, amount_paise: l.amount_paise, note: l.note })),
      ours: { orders: books?.orders ?? 0, sales_paise: books?.sales_paise ?? 0, commission_bp: books?.commission_bp ?? 0, expected_net_paise: expected },
      bank: credit ? { credit_id: credit.id, txn_date: credit.txn_date, amount_paise: credit.amount_paise } : null,
      missing_paise: (books?.sales_paise ?? 0) - r.gross_paise,
      unexplained_paise: r.gross_paise - deductions - r.net_paise,
      vs_expected_paise: r.net_paise - expected,
      bank_gap_paise: credit ? r.net_paise - credit.amount_paise : null,
      dispute: r.dispute_status ? { status: r.dispute_status as 'open' | 'recovered' | 'written_off', note: r.dispute_note, recovered_paise: r.recovered_paise } : null,
    });
  }
  return out;
}
