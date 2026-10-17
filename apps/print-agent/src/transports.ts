// How the agent reaches a printer, and how it finds the printers it can reach.
//
//   192.168.1.50:9100       network printer (LAN or Wi-Fi), raw bytes on port 9100
//   printer:EPSON TM-T82    a printer installed on this computer, usually USB: raw through the
//                           Windows spooler, or CUPS on macOS and Linux
//   /dev/usb/lp0            a USB printer device on Linux, written directly

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FoundPrinter } from '@dineos/shared/print';

export type Transport = (address: string, bytes: Buffer) => Promise<void>;

export type PrinterAddress = { kind: 'network'; host: string; port: number } | { kind: 'system'; name: string } | { kind: 'device'; path: string };

export function parseAddress(address: string): PrinterAddress {
  const a = address.trim();
  if (a.startsWith('printer:')) return { kind: 'system', name: a.slice('printer:'.length).trim() };
  if (a.startsWith('/dev/')) return { kind: 'device', path: a };
  const [host, port] = a.split(':');
  return { kind: 'network', host: host!, port: Number(port || 9100) };
}

/** Sends raw bytes to a network printer (port 9100, "RAW"/JetDirect). */
export function sendToNetwork(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(8000);
    socket.on('timeout', () => socket.destroy(new Error(`printer ${host}:${port} timed out`)));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(bytes));
    socket.on('close', (hadError) => (hadError ? undefined : resolve()));
  });
}

/** Runs a program and resolves with its output; rejects with the end of its error output. */
function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} took too long`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().split(/\r?\n/).slice(-2).join(' ') || `${cmd} exited with code ${code}`));
    });
  });
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const powershell = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);

/** Folder for print files and the Windows helper; the installer sets it to the agent's folder. */
const workDir = () => process.env.DINEOS_HOME ?? join(tmpdir(), 'dineos-agent');

// Windows has no command that sends raw bytes to a printer, so a small helper calls the spooler
// with data type RAW (Microsoft KB 322091). It is compiled once and reused.
const RAW_PRINT_CS = `
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class DineosRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool ClosePrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern bool StartDocPrinter(IntPtr printer, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW doc);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool EndDocPrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool StartPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool EndPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

  public static void Send(string name, string file) {
    byte[] bytes = File.ReadAllBytes(file);
    IntPtr printer;
    if (!OpenPrinter(name, out printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open printer " + name);
    try {
      DOCINFOW doc = new DOCINFOW();
      doc.pDocName = "Mezmitra";
      doc.pDataType = "RAW";
      if (!StartDocPrinter(printer, 1, doc)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        StartPagePrinter(printer);
        int written;
        if (!WritePrinter(printer, bytes, bytes.Length, out written) || written != bytes.Length) throw new Win32Exception(Marshal.GetLastWin32Error());
        EndPagePrinter(printer);
      } finally {
        EndDocPrinter(printer);
      }
    } finally {
      ClosePrinter(printer);
    }
  }
}
`;

let windowsHelper: Promise<string> | null = null;

function rawPrintHelper(): Promise<string> {
  windowsHelper ??= (async () => {
    const dir = workDir();
    const dll = join(dir, 'DineosRawPrint.dll');
    if (existsSync(dll)) return dll;
    await mkdir(dir, { recursive: true });
    const source = join(dir, 'DineosRawPrint.cs');
    await writeFile(source, RAW_PRINT_CS);
    await powershell(`Add-Type -TypeDefinition (Get-Content -Raw ${psQuote(source)}) -OutputAssembly ${psQuote(dll)}`);
    return dll;
  })().catch((err) => {
    windowsHelper = null;
    throw err;
  });
  return windowsHelper;
}

/** Sends raw bytes to a printer installed on this computer, by its name. */
export async function sendToInstalledPrinter(name: string, bytes: Buffer): Promise<void> {
  const dir = workDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `job-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  await writeFile(file, bytes);
  try {
    if (process.platform === 'win32') {
      const dll = await rawPrintHelper();
      await powershell(`Add-Type -Path ${psQuote(dll)}; [DineosRawPrint]::Send(${psQuote(name)}, ${psQuote(file)})`);
    } else {
      await run('lp', ['-d', name, '-o', 'raw', file]);
    }
  } finally {
    await rm(file, { force: true });
  }
}

/** Sends a print job to whatever kind of printer the address names. */
export const defaultTransport: Transport = async (address, bytes) => {
  const a = parseAddress(address);
  if (a.kind === 'network') return sendToNetwork(a.host, a.port, bytes);
  if (a.kind === 'device') return writeFile(a.path, bytes);
  return sendToInstalledPrinter(a.name, bytes);
};

// ------------------------------------------------------------------------------------ discovery

/** Print-to-file and similar drivers that are never a receipt printer. */
const VIRTUAL = /pdf|xps|onenote|fax|send to|microsoft print|anydesk/i;

/** Printers installed on this computer (Windows printers, or CUPS queues on macOS and Linux). */
export async function installedPrinters(): Promise<FoundPrinter[]> {
  try {
    const out =
      process.platform === 'win32'
        ? await powershell('Get-CimInstance -ClassName Win32_Printer | ForEach-Object { $_.Name }')
        : await run('lpstat', ['-e']).catch(async () => (await run('lpstat', ['-a'])).replace(/^(\S+).*$/gm, '$1'));
    return [...new Set(out.split(/\r?\n/).map((s) => s.trim()))]
      .filter((name) => name && !VIRTUAL.test(name))
      .map((name) => ({ address: `printer:${name}`, label: name, kind: 'system' as const }));
  } catch {
    return [];
  }
}

/** USB printer devices on Linux (/dev/usb/lp0 ...). */
export async function usbDevices(): Promise<FoundPrinter[]> {
  if (process.platform !== 'linux') return [];
  try {
    const names = (await readdir('/dev/usb')).filter((f) => /^lp\d+$/.test(f)).sort();
    return names.map((f) => ({ address: `/dev/usb/${f}`, label: `USB printer ${f}`, kind: 'device' as const }));
  } catch {
    return [];
  }
}

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/** The /24 network around each private IPv4 address of this computer. */
export function localNetworks(): { prefix: string; self: string }[] {
  const out = new Map<string, string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !PRIVATE.some((re) => re.test(a.address))) continue;
      out.set(a.address.split('.').slice(0, 3).join('.'), a.address);
    }
  }
  return [...out].map(([prefix, self]) => ({ prefix, self }));
}

function accepts(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const ipOrder = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/**
 * Network printers: machines on this computer's local network that accept connections on the raw
 * printing port. Opening and closing the connection prints nothing.
 */
export async function networkPrinters(opts: { hosts?: string[]; port?: number; timeoutMs?: number; concurrency?: number } = {}): Promise<FoundPrinter[]> {
  const port = opts.port ?? 9100;
  const hosts = opts.hosts ?? localNetworks().flatMap(({ prefix, self }) => Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((h) => h !== self));
  const found: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++]!;
      if (await accepts(host, port, opts.timeoutMs ?? 500)) found.push(host);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 64, hosts.length) }, worker));
  return found.sort(ipOrder).map((host) => ({ address: `${host}:${port}`, label: `Network printer ${host}`, kind: 'network' as const }));
}

/** Every printer this computer can reach: installed (USB) ones, Linux USB devices, network ones. */
export async function discoverPrinters(opts: { hosts?: string[] } = {}): Promise<FoundPrinter[]> {
  const [installed, usb, network] = await Promise.all([installedPrinters(), usbDevices(), networkPrinters(opts)]);
  return [...installed, ...usb, ...network];
}
