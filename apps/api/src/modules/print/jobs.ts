import type { PrintDoc, PrinterConfig, PrintJobDTO } from '@dineos/shared/print';
import type { Tx } from '../../context';
import { json } from '../../db';

async function agentPrinters(tx: Tx, outletId: string) {
  const rows = await tx.db
    .selectFrom('devices')
    .select('config')
    .where('outlet_id', '=', outletId)
    .where('kind', '=', 'print_agent')
    .where('status', '=', 'active')
    .execute();
  return rows.map((r) => (r.config as { printers?: Record<string, PrinterConfig> }).printers ?? {});
}

/**
 * Where the outlet's print agents can print: the targets ('bill' or a station) given a printer in
 * Settings, or null with no print agent (the kitchen screen and browser printing still work). A
 * station without a printer is left to the kitchen screen instead of failing every ticket. An
 * agent with no printers in the portal may have its own local ones, so it takes every target.
 */
export async function printTargets(tx: Tx, outletId: string): Promise<{ has(target: string): boolean } | null> {
  const agents = await agentPrinters(tx, outletId);
  if (agents.length === 0) return null;
  const targets = new Set<string>();
  for (const printers of agents) {
    const keys = Object.keys(printers);
    if (keys.length === 0 || keys.includes('default')) return { has: () => true };
    for (const k of keys) targets.add(k);
  }
  return { has: (target) => targets.has(target) };
}

/** True when the outlet has an active print agent; without one the KDS screen is the kitchen ticket. */
export async function hasPrintAgent(tx: Tx, outletId: string): Promise<boolean> {
  return (await printTargets(tx, outletId)) !== null;
}

/** Whether `target` ('bill' or a station) has a printer. */
export async function canPrint(tx: Tx, outletId: string, target: string): Promise<boolean> {
  return (await printTargets(tx, outletId))?.has(target) ?? false;
}

/** Opens the cash drawer wired to the bill printer, when Settings says it has one. */
export async function openCashDrawer(tx: Tx, outletId: string): Promise<void> {
  const agents = await agentPrinters(tx, outletId);
  if (agents.some((printers) => printers.bill?.drawer)) await queuePrintJob(tx, outletId, { target: 'bill', doc: { kind: 'drawer' } });
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
