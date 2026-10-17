// Mezmitra print agent: runs on one always-on computer at the outlet (the billing PC, a Mac or a
// Raspberry Pi), prints kitchen tickets and bills on its printers, and opens the cash drawer.
//
// The installer from Settings > Printers sets it up as a service and writes mezmitra-agent.json
// next to it (dineos-agent.json on computers installed before the rename, still read):
//   { "api_url": "https://api.example.com", "token": "dv_...", "log_file": "agent.log" }
// Environment variables override the file:
//   MEZMITRA_API_URL, MEZMITRA_DEVICE_TOKEN, MEZMITRA_CONFIG (path of the file); DINEOS_* still work
// Printers are chosen in the portal (Settings > Printers). To override locally:
//   MEZMITRA_PRINTERS='{"kitchen":{"address":"192.168.1.50:9100","width":48}}'
// To see output without a printer:   MEZMITRA_DRY_RUN=1  (prints a text preview to the console)
// To skip looking for printers:      MEZMITRA_SCAN=0
// Printers on another network:       MEZMITRA_SCAN_HOSTS=10.0.5.20,10.0.5.21 (checked instead of this one)
//
// Outlet hub (keeps the outlet trading on the LAN when the internet is down; choose this device as
// the hub in Settings > Printers first): "hub": true in the file, or MEZMITRA_HUB=1, with
//   MEZMITRA_HUB_PORT=4100 MEZMITRA_HUB_DATA=/var/lib/mezmitra/hub.json MEZMITRA_HUB_WEB=http://127.0.0.1:3000

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrintJobDTO } from '@mezmitra/shared/print';
import { PrintAgent, type PrinterConfig, type Transport } from './agent';
import { OutletHub } from './hub/hub';
import { render } from './render';
import { discoverPrinters } from './transports';
import { env } from './env';
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
// Computers installed before the rename keep their dineos-agent.json until the installer runs again.
const firstExisting = (...names: string[]) => names.map((n) => join(here, n)).find((p) => existsSync(p));
const configPath = env('CONFIG') ?? firstExisting('mezmitra-agent.json', 'dineos-agent.json') ?? join(here, 'mezmitra-agent.json');
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
process.env.MEZMITRA_HOME ??= env('HOME') ?? dirname(configPath);

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

const apiUrl = env('API_URL') ?? file.api_url ?? 'http://localhost:4000';
const token = env('DEVICE_TOKEN') ?? file.token ?? '';
if (!token.startsWith('dv_')) {
  console.error('Set the device token (MEZMITRA_DEVICE_TOKEN or "token" in mezmitra-agent.json): it is shown when you add a print computer in Settings > Printers.');
  process.exit(1);
}
console.log(`[print-agent] Mezmitra print agent ${AGENT_VERSION} starting for ${apiUrl}`);

let printers: Record<string, PrinterConfig> | undefined;
const printersEnv = env('PRINTERS');
if (printersEnv) {
  try {
    printers = JSON.parse(printersEnv);
  } catch {
    console.error('MEZMITRA_PRINTERS is not valid JSON');
    process.exit(1);
  }
}

const dryRun = env('DRY_RUN') === '1';
const preview: Transport = async (address) => console.log(`--- would send to ${address} ---`);
if (dryRun) {
  // Every target falls back to a fake printer so jobs can be inspected without hardware.
  printers = { default: { address: 'dry-run:9100', width: 48 }, ...(printers ?? {}) };
}
const scanHosts = env('SCAN_HOSTS')?.split(',').map((h) => h.trim()).filter(Boolean);
const discover = env('SCAN') === '0' ? undefined : () => discoverPrinters(scanHosts?.length ? { hosts: scanHosts } : {});

if (env('HUB') === '1' || file.hub) {
  const hub = new OutletHub({
    apiUrl,
    token,
    printers,
    transport: dryRun ? preview : undefined,
    discover,
    port: Number(env('HUB_PORT') ?? file.hub_port ?? 4100),
    // An outlet's offline records stay where they are: dineos-hub.json on computers installed before the rename.
    dataFile: env('HUB_DATA') ?? (file.hub_data ? inHere(file.hub_data) : [inHere('mezmitra-hub.json'), inHere('dineos-hub.json')].find((f) => existsSync(f)) ?? inHere('mezmitra-hub.json')),
    webUpstream: env('HUB_WEB') ?? file.hub_web ?? 'http://127.0.0.1:3000',
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
      console.error(`[print-agent] could not reach Mezmitra (${err.message}); trying again in ${wait} s`);
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
