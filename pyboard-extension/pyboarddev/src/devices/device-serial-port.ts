/**
 * Module overview:
 * Wraps a serial transport with connect/disconnect/runtime operations and
 * emits serial-port lifecycle events.
 */
import { MicroPythonDevice, PyDeviceRuntimeInfo } from './py-device';
import { Disposable } from './disposable';
import { PyDeviceTransport } from './py-device-transport';

export type DeviceSerialPortEvent =
  | { type: 'connected'; path: string }
  | { type: 'disconnected'; path: string }
  | { type: 'runtimeInfo'; path: string; runtimeInfo: PyDeviceRuntimeInfo | undefined }
  | { type: 'error'; path: string; error: unknown };

type DeviceSerialPortListener = (event: DeviceSerialPortEvent) => void;

const defaultTransportFactory = (devicePath: string, baudRate: number, reportErrorsToUser: boolean): PyDeviceTransport => {
  return new MicroPythonDevice(devicePath, baudRate, reportErrorsToUser);
};

export type { Disposable, PyDeviceTransport };

export class DeviceSerialPort {
  private readonly listeners = new Set<DeviceSerialPortListener>();
  private transport: PyDeviceTransport | undefined;

  constructor(
    public readonly path: string,
    public readonly baudRate: number = 115200,
    private readonly reportErrorsToUser: boolean = true,
    private readonly transportFactory: (devicePath: string, baudRate: number, reportErrorsToUser: boolean) => PyDeviceTransport = defaultTransportFactory
  ) {}

  get isConnected(): boolean {
    return this.transport !== undefined;
  }

  getTransport(): PyDeviceTransport | undefined {
    return this.transport;
  }

  onDidChange(listener: DeviceSerialPortListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  }

  async connect(): Promise<void> {
    if (this.transport) {
      return;
    }

    const transport = this.transportFactory(this.path, this.baudRate, this.reportErrorsToUser);
    try {
      await transport.open();
      this.transport = transport;
      this.emit({ type: 'connected', path: this.path });
    } catch (error) {
      this.emit({ type: 'error', path: this.path, error });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const current = this.transport;
    if (!current) {
      return;
    }

    try {
      await current.close();
      this.transport = undefined;
      this.emit({ type: 'disconnected', path: this.path });
    } catch (error) {
      this.emit({ type: 'error', path: this.path, error });
      throw error;
    }
  }

  async probeRuntimeInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo | undefined> {
    if (this.transport) {
      const runtimeInfo = await this.transport.probeBoardRuntimeInfo(timeoutMs);
      this.emit({ type: 'runtimeInfo', path: this.path, runtimeInfo });
      return runtimeInfo;
    }

    const transientTransport = this.transportFactory(this.path, this.baudRate, false);
    try {
      await transientTransport.open();
      const runtimeInfo = await transientTransport.probeBoardRuntimeInfo(timeoutMs);
      this.emit({ type: 'runtimeInfo', path: this.path, runtimeInfo });
      return runtimeInfo;
    } catch (error) {
      this.emit({ type: 'error', path: this.path, error });
      return undefined;
    } finally {
      try {
        await transientTransport.close();
      } catch {
        // Ignore close failures for probe-only sessions.
      }
    }
  }

  async getRuntimeInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo | undefined> {
    if (!this.transport) {
      throw new Error(`Serial port is not connected: ${this.path}`);
    }
    const runtimeInfo = await this.transport.getBoardRuntimeInfo(timeoutMs);
    this.emit({ type: 'runtimeInfo', path: this.path, runtimeInfo });
    return runtimeInfo;
  }

  async softReboot(): Promise<void> {
    if (!this.transport) {
      throw new Error(`Serial port is not connected: ${this.path}`);
    }
    await this.transport.softReboot();
  }

  private emit(event: DeviceSerialPortEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
