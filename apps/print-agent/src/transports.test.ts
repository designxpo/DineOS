import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from './render';
import { defaultTransport, networkPrinters, parseAddress } from './transports';

let printer: Server;
let port = 0;
const received: Buffer[] = [];

beforeAll(async () => {
  printer = createServer((s) => {
    const chunks: Buffer[] = [];
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => received.push(Buffer.concat(chunks)));
  });
  await new Promise<void>((r) => printer.listen(0, '127.0.0.1', r));
  port = (printer.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => printer.close(() => r())));

describe('printer addresses', () => {
  it('tells network, installed and Linux USB printers apart', () => {
    expect(parseAddress('192.168.1.50:9100')).toEqual({ kind: 'network', host: '192.168.1.50', port: 9100 });
    expect(parseAddress('192.168.1.50')).toEqual({ kind: 'network', host: '192.168.1.50', port: 9100 });
    expect(parseAddress('printer:EPSON TM-T82 Receipt')).toEqual({ kind: 'system', name: 'EPSON TM-T82 Receipt' });
    expect(parseAddress('/dev/usb/lp0')).toEqual({ kind: 'device', path: '/dev/usb/lp0' });
  });

  it('sends raw bytes to a network printer', async () => {
    await defaultTransport(`127.0.0.1:${port}`, Buffer.from('hello'));
    await expect.poll(() => received.some((b) => b.toString() === 'hello')).toBe(true);
  });
});

describe('finding printers', () => {
  it('finds machines that accept print jobs, without printing anything on them', async () => {
    const before = received.length;
    // 127.0.0.2 has nothing listening on that port on this machine.
    const found = await networkPrinters({ hosts: ['127.0.0.2', '127.0.0.1'], port, timeoutMs: 300 });
    expect(found).toEqual([{ address: `127.0.0.1:${port}`, label: 'Network printer 127.0.0.1', kind: 'network' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(received.slice(before).every((b) => b.length === 0)).toBe(true);
  });
});

describe('cash drawer', () => {
  it('is a pulse on the drawer port and prints nothing', () => {
    const doc = render({ kind: 'drawer' }, 48);
    expect([...doc.build()]).toEqual([0x1b, 0x40, 0x1b, 0x70, 0, 25, 250]);
    expect(doc.preview).toEqual(['[open cash drawer]']);
  });
});
