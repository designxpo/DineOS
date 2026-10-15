// DineOS print agent.
//
//   DINEOS_API_URL=https://api.dineos.in DINEOS_DEVICE_TOKEN=dv_... dineos-print-agent
//
// Printers are configured per outlet in the portal (Settings > Printers). To override locally:
//   DINEOS_PRINTERS='{"kitchen":{"address":"192.168.1.50:9100","width":48}}'
// To see output without a printer:
//   DINEOS_DRY_RUN=1  (prints a text preview to the console)
//
// Outlet hub (keeps the outlet trading on the LAN when the internet is down; choose this device as
// the hub in Settings > Printers first):
//   DINEOS_HUB=1 DINEOS_HUB_PORT=4100 DINEOS_HUB_DATA=/var/lib/dineos/hub.json \
//   DINEOS_HUB_WEB=http://127.0.0.1:3000 dineos-print-agent

import type { PrintJobDTO } from '@dineos/shared/print';
import { PrintAgent, type PrinterConfig, type Transport } from './agent';
import { OutletHub } from './hub/hub';
import { render } from './render';

const apiUrl = process.env.DINEOS_API_URL ?? 'http://localhost:4000';
const token = process.env.DINEOS_DEVICE_TOKEN ?? '';
if (!token.startsWith('dv_')) {
  console.error(
    'Set DINEOS_DEVICE_TOKEN to the device token shown when you added this printer in the portal.',
  );
  process.exit(1);
}

let printers: Record<string, PrinterConfig> | undefined;
if (process.env.DINEOS_PRINTERS) {
  try {
    printers = JSON.parse(process.env.DINEOS_PRINTERS);
  } catch {
    console.error('DINEOS_PRINTERS is not valid JSON');
    process.exit(1);
  }
}

const dryRun = process.env.DINEOS_DRY_RUN === '1';
const preview: Transport = async (address) => console.log(`--- would send to ${address} ---`);
if (dryRun) {
  // Every target falls back to a fake printer so jobs can be inspected without hardware.
  printers = { default: { address: 'dry-run:9100', width: 48 }, ...(printers ?? {}) };
}

if (process.env.DINEOS_HUB === '1') {
  const hub = new OutletHub({
    apiUrl,
    token,
    printers,
    transport: dryRun ? preview : undefined,
    port: Number(process.env.DINEOS_HUB_PORT ?? 4100),
    dataFile: process.env.DINEOS_HUB_DATA ?? 'dineos-hub.json',
    webUpstream: process.env.DINEOS_HUB_WEB ?? 'http://127.0.0.1:3000',
  });
  hub.start().catch((err) => {
    console.error(`Could not start the outlet hub: ${err.message}`);
    process.exit(1);
  });
  const stopHub = async () => {
    await hub.stop();
    process.exit(0);
  };
  process.on('SIGINT', stopHub);
  process.on('SIGTERM', stopHub);
} else {
  startAgent();
}

function startAgent() {
  const agent = new PrintAgent({
    apiUrl,
    token,
    printers,
    transport: dryRun ? preview : undefined,
  });

  if (dryRun) {
    const original = agent.enqueue.bind(agent);
    agent.enqueue = (job: PrintJobDTO) => {
      console.log(render(job.doc, 48).preview.join('\n'));
      original(job);
    };
  }

  agent.start().catch((err) => {
    console.error(`Could not start: ${err.message}`);
    process.exit(1);
  });

  const stop = async () => {
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
