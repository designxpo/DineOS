// DineOS print agent: runs on one always-on computer at the outlet (the billing PC, a Mac or a
// Raspberry Pi), prints kitchen tickets and bills on its printers, and opens the cash drawer.
//
// The installer from Settings > Printers sets it up as a service and writes dineos-agent.json
// next to it:
//   { "api_url": "https://api.example.com", "token": "dv_...", "log_file": "agent.log" }
// Environment variables override the file:
//   DINEOS_API_URL, DINEOS_DEVICE_TOKEN, DINEOS_CONFIG (path of the file)
// Printers are chosen in the portal (Settings > Printers). To override locally:
//   DINEOS_PRINTERS='{"kitchen":{"address":"192.168.1.50:9100","width":48}}'
// To see output without a printer:   DINEOS_DRY_RUN=1  (prints a text preview to the console)
// To skip looking for printers:      DINEOS_SCAN=0
// Printers on another network:       DINEOS_SCAN_HOSTS=10.0.5.20,10.0.5.21 (checked instead of this one)
//
// Outlet hub (keeps the outlet trading on the LAN when the internet is down; choose this device as
// the hub in Settings > Printers first): "hub": true in the file, or DINEOS_HUB=1, with
//   DINEOS_HUB_PORT=4100 DINEOS_HUB_DATA=/var/lib/dineos/hub.json DINEOS_HUB_WEB=http://127.0.0.1:3000

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrintJobDTO } from '@dineos/shared/print';
import { PrintAgent, type PrinterConfig, type Transport } from './agent';
import { OutletHub } from './hub/hub';
import { render } from './render';
import { discoverPrinters } from './transports';
import { AGENT_VERSION } from './version';

interface FileConfig {
  api_url?: string;
  token?: string;
  log_file?: string;
  hub?: boolean;
  hub_port?: number;
  hub_data?: string;
  hub_web?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.DINEOS_CONFIG ?? join(here, 'dineos-agent.json');
let file: FileConfig = {};
if (existsSync(configPath)) {
  try {
    // Windows PowerShell may write a byte-order mark.
    file = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) as FileConfig;
  } catch {
    console.error(`${configPath} is not valid JSON`);
    process.exit(1);
  }
}
const inHere = (p: string) => (isAbsolute(p) ? p : join(dirname(configPath), p));
process.env.DINEOS_HOME ??= dirname(configPath);

// A service has no console to read, so the installer asks for a log file (kept under ~5 MB).
if (file.log_file) {
  const logFile = inHere(file.log_file);
  const write = (line: string) => {
    try {
      if (existsSync(logFile) && statSync(logFile).size > 5_000_000) renameSync(logFile, `${logFile}.1`);
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // logging must never stop printing
    }
  };
  for (const level of ['log', 'error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(args.map(String).join(' '));
    };
  }
}

const apiUrl = process.env.DINEOS_API_URL ?? file.api_url ?? 'http://localhost:4000';
const token = process.env.DINEOS_DEVICE_TOKEN ?? file.token ?? '';
if (!token.startsWith('dv_')) {
  console.error('Set the device token (DINEOS_DEVICE_TOKEN or "token" in dineos-agent.json): it is shown when you add a print computer in Settings > Printers.');
  process.exit(1);
}
console.log(`[print-agent] DineOS print agent ${AGENT_VERSION} starting for ${apiUrl}`);

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
const scanHosts = process.env.DINEOS_SCAN_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
const discover = process.env.DINEOS_SCAN === '0' ? undefined : () => discoverPrinters(scanHosts?.length ? { hosts: scanHosts } : {});

if (process.env.DINEOS_HUB === '1' || file.hub) {
  const hub = new OutletHub({
    apiUrl,
    token,
    printers,
    transport: dryRun ? preview : undefined,
    discover,
    port: Number(process.env.DINEOS_HUB_PORT ?? file.hub_port ?? 4100),
    dataFile: process.env.DINEOS_HUB_DATA ?? (file.hub_data ? inHere(file.hub_data) : inHere('dineos-hub.json')),
    webUpstream: process.env.DINEOS_HUB_WEB ?? file.hub_web ?? 'http://127.0.0.1:3000',
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
    discover,
  });

  if (dryRun) {
    const original = agent.enqueue.bind(agent);
    agent.enqueue = (job: PrintJobDTO) => {
      console.log(render(job.doc, 48).preview.join('\n'));
      original(job);
    };
  }

  // The service manager restarts the agent if it exits; retry the first connection in place so a
  // computer that boots before its network comes up does not churn.
  const begin = (attempt: number) =>
    agent.start().catch((err) => {
      const wait = Math.min(60, 5 * attempt);
      console.error(`[print-agent] could not reach DineOS (${err.message}); trying again in ${wait} s`);
      setTimeout(() => begin(attempt + 1), wait * 1000);
    });
  void begin(1);

  const stop = async () => {
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
