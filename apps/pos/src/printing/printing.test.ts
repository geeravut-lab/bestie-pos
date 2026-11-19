import { describe, expect, it, vi } from 'vitest';
import type { Printer } from '@bestie/core';
import { PrintError, sendEscpos, supportedKinds } from './drivers';
import type { PrintEnv } from './drivers';
import { printPicture } from './print';
import type { Picture } from './print';
import { printErrorKey } from './PrintButton';

const base = { id: 'x', name: 'Counter', paperMm: 58, cutter: true, drawer: false } as const;
const mk = (p: Partial<Printer> & Pick<Printer, 'kind'>): Printer => ({ ...base, ...p }) as Printer;
const pic = (): Picture => ({
  width: 384,
  height: 8,
  rgba: () => new Uint8Array(384 * 8 * 4).fill(0),
  jpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
});
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as PrintError;
  }
  return null;
};

describe('printPicture', () => {
  it('a PDF printer saves a PDF named after the receipt and sends nothing to a device', async () => {
    const savePdf = vi.fn();
    const fetch = vi.fn();
    await printPicture(mk({ kind: 'pdf' }), 'A+000001', {
      draw: async () => pic(),
      savePdf,
      env: { navigator: {}, fetch: fetch as never },
    });
    expect(savePdf).toHaveBeenCalledTimes(1);
    const [bytes, name] = savePdf.mock.calls[0] as [Uint8Array, string];
    expect(name).toBe('A+000001.pdf');
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('draws 384 dots on 58 mm paper and 576 on 80 mm', async () => {
    const draw = vi.fn(async () => pic());
    await printPicture(mk({ kind: 'pdf', paperMm: 80 }), 't', { draw, savePdf: vi.fn() });
    await printPicture(mk({ kind: 'pdf', paperMm: 58 }), 't', { draw, savePdf: vi.fn() });
    expect(draw.mock.calls.map((c) => (c as unknown[])[0])).toEqual([576, 384]);
  });

  it('a network printer posts raw ESC/POS bytes to the bridge', async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    await printPicture(mk({ kind: 'network', bridgeUrl: 'http://192.168.1.5:9101/print' }), 't', {
      draw: async () => pic(),
      savePdf: vi.fn(),
      env: { navigator: {}, fetch: fetch as never },
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: Uint8Array }];
    expect(url).toBe('http://192.168.1.5:9101/print');
    expect(init.body[0]).toBe(0x1b); // ESC @ (initialise) comes first
    expect(init.body[1]).toBe(0x40);
  });

  it('a drawing failure is a plain "failed", not a leaked message', async () => {
    const e = await err(
      printPicture(mk({ kind: 'pdf' }), 't', {
        draw: async () => {
          throw new Error('canvas exploded');
        },
        savePdf: vi.fn(),
      }),
    );
    expect(e?.code).toBe('failed');
  });

  it('the browser dialog is the caller’s job', async () => {
    const e = await err(
      printPicture(mk({ kind: 'browser' }), 't', { draw: async () => pic(), savePdf: vi.fn() }),
    );
    expect(e?.code).toBe('unsupported');
  });
});

describe('device drivers', () => {
  it('USB: picks the first bulk-out endpoint, sends in chunks and closes', async () => {
    const out: number[] = [];
    const device = {
      opened: false,
      configuration: {
        interfaces: [
          {
            interfaceNumber: 1,
            alternate: {
              interfaceClass: 7,
              endpoints: [
                { direction: 'in', type: 'bulk', endpointNumber: 1 },
                { direction: 'out', type: 'bulk', endpointNumber: 2 },
              ],
            },
          },
        ],
      },
      open: vi.fn(async () => {}),
      selectConfiguration: vi.fn(async () => {}),
      claimInterface: vi.fn(async () => {}),
      transferOut: vi.fn(async (_ep: number, d: Uint8Array) => void out.push(d.length)),
      close: vi.fn(async () => {}),
    };
    const env: PrintEnv = {
      navigator: { usb: { getDevices: async () => [device], requestDevice: vi.fn() } },
      fetch: vi.fn() as never,
    };
    await sendEscpos(mk({ kind: 'usb' }), new Uint8Array(10000), env);
    expect(device.claimInterface).toHaveBeenCalledWith(1);
    expect(device.transferOut.mock.calls.every((c) => c[0] === 2)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(Math.max(...out)).toBeLessThanOrEqual(4096);
    expect(device.close).toHaveBeenCalled();
  });

  it('USB: closing the permission prompt is "cancelled"', async () => {
    const env: PrintEnv = {
      navigator: {
        usb: {
          getDevices: async () => [],
          requestDevice: async () => {
            throw Object.assign(new Error('x'), { name: 'NotFoundError' });
          },
        },
      },
      fetch: vi.fn() as never,
    };
    expect((await err(sendEscpos(mk({ kind: 'usb' }), new Uint8Array(3), env)))?.code).toBe(
      'cancelled',
    );
  });

  it('Serial: opens at the printer’s baud rate, writes and releases the port', async () => {
    const written: number[] = [];
    const release = vi.fn();
    const port = {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      writable: {
        getWriter: () => ({
          write: async (d: Uint8Array) => void written.push(d.length),
          releaseLock: release,
        }),
      },
    };
    const env: PrintEnv = {
      navigator: { serial: { getPorts: async () => [port], requestPort: vi.fn() } },
      fetch: vi.fn() as never,
    };
    await sendEscpos(mk({ kind: 'serial', baud: 115200 }), new Uint8Array(5000), env);
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200 });
    expect(written.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(release).toHaveBeenCalled();
    expect(port.close).toHaveBeenCalled();
  });

  it('Bluetooth: writes in small pieces to the first writable characteristic', async () => {
    const parts: number[] = [];
    const ch = {
      properties: { write: false, writeWithoutResponse: true },
      writeValueWithoutResponse: async (d: Uint8Array) => void parts.push(d.length),
      writeValue: vi.fn(),
    };
    const disconnect = vi.fn();
    const env: PrintEnv = {
      navigator: {
        bluetooth: {
          requestDevice: async () => ({
            gatt: {
              connect: async () => ({
                getPrimaryServices: async () => [{ getCharacteristics: async () => [ch] }],
                getPrimaryService: vi.fn(),
                disconnect,
              }),
            },
          }),
        },
      },
      fetch: vi.fn() as never,
    };
    await sendEscpos(mk({ kind: 'bluetooth' }), new Uint8Array(250), env);
    expect(parts).toEqual([100, 100, 50]);
    expect(ch.writeValue).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it('a browser without the device API says "unsupported"', async () => {
    const env: PrintEnv = { navigator: {}, fetch: vi.fn() as never };
    for (const kind of ['usb', 'serial', 'bluetooth'] as const)
      expect((await err(sendEscpos(mk({ kind }), new Uint8Array(1), env)))?.code).toBe(
        'unsupported',
      );
    expect(supportedKinds(env)).toMatchObject({
      pdf: true,
      browser: true,
      network: true,
      usb: false,
      serial: false,
      bluetooth: false,
    });
  });

  it('Bridge: no address or a refusing bridge is "bridge"', async () => {
    const env = (ok: boolean): PrintEnv => ({
      navigator: {},
      fetch: (async () => ({ ok })) as never,
    });
    expect(
      (await err(sendEscpos(mk({ kind: 'network' }), new Uint8Array(1), env(true))))?.code,
    ).toBe('bridge');
    expect(
      (
        await err(
          sendEscpos(
            mk({ kind: 'network', bridgeUrl: 'http://x/' }),
            new Uint8Array(1),
            env(false),
          ),
        )
      )?.code,
    ).toBe('bridge');
    const down: PrintEnv = {
      navigator: {},
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as never,
    };
    expect(
      (
        await err(
          sendEscpos(mk({ kind: 'network', bridgeUrl: 'http://x/' }), new Uint8Array(1), down),
        )
      )?.code,
    ).toBe('bridge');
  });

  it('maps every failure to a translated error key', () => {
    expect(printErrorKey(new PrintError('bridge'))).toBe('err_print_bridge');
    expect(printErrorKey(new PrintError('cancelled'))).toBe('err_print_cancelled');
    expect(printErrorKey(new Error('anything'))).toBe('err_print_failed');
  });
});
