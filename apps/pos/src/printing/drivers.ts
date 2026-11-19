import type { Printer } from '@bestie/core';

/** Why a print failed, in words the screen can translate (never a provider / driver message). */
export type PrintErrorCode = 'unsupported' | 'cancelled' | 'no_device' | 'failed' | 'bridge';
export class PrintError extends Error {
  constructor(readonly code: PrintErrorCode) {
    super(`print ${code}`);
    this.name = 'PrintError';
  }
}

// Minimal shapes of the browser APIs (they are not in TypeScript's DOM lib); tests inject fakes.
type UsbEndpoint = { direction: string; type: string; endpointNumber: number };
type UsbDevice = {
  opened: boolean;
  configuration: {
    interfaces: {
      interfaceNumber: number;
      alternate: { interfaceClass: number; endpoints: UsbEndpoint[] };
    }[];
  } | null;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(ep: number, data: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
};
type SerialPort = {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  writable: { getWriter(): { write(d: Uint8Array): Promise<void>; releaseLock(): void } } | null;
};
type BleChar = {
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValueWithoutResponse?(d: Uint8Array): Promise<void>;
  writeValue(d: Uint8Array): Promise<void>;
};
type BleDevice = {
  gatt: {
    connect(): Promise<{
      getPrimaryServices(s?: string): Promise<{ getCharacteristics(): Promise<BleChar[]> }[]>;
      getPrimaryService(s: string): Promise<{ getCharacteristics(): Promise<BleChar[]> }>;
      disconnect(): void;
    }>;
  };
};
export type PrintEnv = {
  navigator: {
    usb?: { getDevices(): Promise<UsbDevice[]>; requestDevice(o: object): Promise<UsbDevice> };
    serial?: { getPorts(): Promise<SerialPort[]>; requestPort(o?: object): Promise<SerialPort> };
    bluetooth?: { requestDevice(o: object): Promise<BleDevice> };
  };
  fetch: typeof fetch;
};
const realEnv = (): PrintEnv => ({
  navigator: globalThis.navigator as unknown as PrintEnv['navigator'],
  fetch: globalThis.fetch.bind(globalThis),
});

/** Which kinds this browser can talk to (a tablet's Safari has none of the three device APIs; the PDF and the bridge always work). */
export function supportedKinds(env: PrintEnv = realEnv()): Record<Printer['kind'], boolean> {
  const n = env.navigator;
  return {
    pdf: true,
    browser: true,
    network: true,
    usb: !!n.usb,
    serial: !!n.serial,
    bluetooth: !!n.bluetooth,
  };
}

const CHUNK = 4096;
const BLE_CHUNK = 100;
const BLE_COMMON_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];
const toUuid = (s: string) =>
  /^[0-9a-f]{4}$/i.test(s) ? `0000${s.toLowerCase()}-0000-1000-8000-00805f9b34fb` : s.toLowerCase();
const cancelled = (e: unknown) =>
  e instanceof Error &&
  (e.name === 'NotFoundError' || e.name === 'AbortError' || e.name === 'NotAllowedError');

async function viaUsb(bytes: Uint8Array, env: PrintEnv): Promise<void> {
  const usb = env.navigator.usb;
  if (!usb) throw new PrintError('unsupported');
  let device: UsbDevice | undefined;
  try {
    device =
      (await usb.getDevices())[0] ?? (await usb.requestDevice({ filters: [{ classCode: 7 }] }));
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const iface = device.configuration?.interfaces.find((i) =>
      i.alternate.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk'),
    );
    const ep = iface?.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    if (!iface || !ep) throw new PrintError('no_device');
    await device.claimInterface(iface.interfaceNumber);
    for (let i = 0; i < bytes.length; i += CHUNK)
      await device.transferOut(ep.endpointNumber, bytes.subarray(i, i + CHUNK));
  } catch (e) {
    if (e instanceof PrintError) throw e;
    throw new PrintError(cancelled(e) ? 'cancelled' : 'failed');
  } finally {
    try {
      await device?.close();
    } catch {
      /* already closed */
    }
  }
}

async function viaSerial(bytes: Uint8Array, p: Printer, env: PrintEnv): Promise<void> {
  const serial = env.navigator.serial;
  if (!serial) throw new PrintError('unsupported');
  let port: SerialPort | undefined;
  try {
    port = (await serial.getPorts())[0] ?? (await serial.requestPort());
    await port.open({ baudRate: p.baud ?? 9600 });
    const w = port.writable?.getWriter();
    if (!w) throw new PrintError('no_device');
    try {
      for (let i = 0; i < bytes.length; i += CHUNK) await w.write(bytes.subarray(i, i + CHUNK));
    } finally {
      w.releaseLock();
    }
  } catch (e) {
    if (e instanceof PrintError) throw e;
    throw new PrintError(cancelled(e) ? 'cancelled' : 'failed');
  } finally {
    try {
      await port?.close();
    } catch {
      /* already closed */
    }
  }
}

async function viaBluetooth(bytes: Uint8Array, p: Printer, env: PrintEnv): Promise<void> {
  const ble = env.navigator.bluetooth;
  if (!ble) throw new PrintError('unsupported');
  const services = [
    ...new Set([...(p.service ? [toUuid(p.service)] : []), ...BLE_COMMON_SERVICES]),
  ];
  try {
    const device = await ble.requestDevice({ acceptAllDevices: true, optionalServices: services });
    const server = await device.gatt.connect();
    let target: BleChar | undefined;
    for (const s of await server.getPrimaryServices()) {
      target = (await s.getCharacteristics()).find(
        (c) => c.properties.write || c.properties.writeWithoutResponse,
      );
      if (target) break;
    }
    if (!target) throw new PrintError('no_device');
    for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
      const part = bytes.subarray(i, i + BLE_CHUNK);
      if (target.properties.writeWithoutResponse && target.writeValueWithoutResponse)
        await target.writeValueWithoutResponse(part);
      else await target.writeValue(part);
    }
    server.disconnect();
  } catch (e) {
    if (e instanceof PrintError) throw e;
    throw new PrintError(cancelled(e) ? 'cancelled' : 'failed');
  }
}

/** A small program on a computer in the shop forwards these bytes to the printer's TCP port 9100 (browsers cannot do that themselves). */
async function viaBridge(bytes: Uint8Array, p: Printer, env: PrintEnv): Promise<void> {
  if (!p.bridgeUrl) throw new PrintError('bridge');
  try {
    const res = await env.fetch(p.bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) throw new PrintError('bridge');
  } catch (e) {
    throw e instanceof PrintError ? e : new PrintError('bridge');
  }
}

/** Send ESC/POS bytes to a device printer. The PDF and the browser dialog are handled by the caller, not here. */
export async function sendEscpos(
  printer: Printer,
  bytes: Uint8Array,
  env: PrintEnv = realEnv(),
): Promise<void> {
  switch (printer.kind) {
    case 'usb':
      return viaUsb(bytes, env);
    case 'serial':
      return viaSerial(bytes, printer, env);
    case 'bluetooth':
      return viaBluetooth(bytes, printer, env);
    case 'network':
      return viaBridge(bytes, printer, env);
    default:
      throw new PrintError('unsupported');
  }
}
