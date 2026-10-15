import type { PrintDoc, PrintJobDTO } from '@dineos/shared/print';
import type { Tx } from '../../context';
import { json } from '../../db';

/** True when the outlet has an active print agent; without one the KDS screen is the kitchen ticket. */
export async function hasPrintAgent(tx: Tx, outletId: string): Promise<boolean> {
  const row = await tx.db
    .selectFrom('devices')
    .select('id')
    .where('outlet_id', '=', outletId)
    .where('kind', '=', 'print_agent')
    .where('status', '=', 'active')
    .executeTakeFirst();
  return !!row;
}

/**
 * Queues a print job and pushes it to the outlet's print agents after commit. Agents ack over
 * REST; jobs still queued or sent are re-delivered when an agent reconnects.
 */
export async function queuePrintJob(
  tx: Tx,
  outletId: string,
  job: { target: string; refId?: string | null; doc: PrintDoc },
): Promise<PrintJobDTO> {
  const row = await tx.db
    .insertInto('print_jobs')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: outletId,
      kind: job.doc.kind,
      target: job.target,
      ref_id: job.refId ?? null,
      doc: json(job.doc),
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  const dto: PrintJobDTO = {
    id: row.id,
    kind: job.doc.kind,
    target: job.target,
    doc: job.doc,
    status: 'queued',
    attempts: 0,
    created_at: row.created_at.toISOString(),
  };
  await tx.emit({ outletId, type: 'print.job', channels: ['print'], payload: dto });
  return dto;
}
