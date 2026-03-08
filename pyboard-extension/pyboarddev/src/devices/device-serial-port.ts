/**
 * Module overview:
 * Wraps a serial transport with connect/disconnect/runtime operations and
 * emits serial-port lifecycle events.
 */
import { MicroPythonDevice, PyDeviceRuntimeInfo } from './py-device';
import { Disposable } from './disposable';
import { PyDeviceTransport } from './py-device-transport';
import { emitPyDeviceLoggerEvent } from '../pydevice-logger-events';
import { pyDeviceTimeoutSettings } from '../constants/timeout-constants';
import { getTimeoutSettingMs, resolveTimeoutMs } from '../utils/timeout-settings';

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
};

export type DeviceSerialPortEvent =
  | { type: 'connected'; path: string }
  | { type: 'disconnected'; path: string }
  | { type: 'runtimeInfo'; path: string; runtimeInfo: PyDeviceRuntimeInfo | undefined }
  | { type: 'error'; path: string; error: unknown };

type DeviceSerialPortListener = (event: DeviceSerialPortEvent) => void;
type ProbeRuntimeInfoResult = {
  status: 'detected' | 'noDevice' | 'unavailable';
  runtimeInfo?: PyDeviceRuntimeInfo;
  reason?: string;
  waitingForCloseCompletion?: boolean;
  waitForCloseCompletion?: Promise<void>;
};

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
    const result = await this.probeRuntimeInfoDetailed(timeoutMs);
    return result.runtimeInfo;
  }

  async probeRuntimeInfoDetailed(timeoutMs?: number): Promise<ProbeRuntimeInfoResult> {
    const probeRuntimeTimeoutMs = resolveTimeoutMs(pyDeviceTimeoutSettings.pythonProbeRuntimeInfo, timeoutMs);
    const serialPortOperationTimeoutMs = getTimeoutSettingMs(pyDeviceTimeoutSettings.serialPortOperation);
    if (this.transport) {
      emitPyDeviceLoggerEvent({
        source: 'ProbeDevices',
        level: 'debug',
        action: 'probe-runtime-existing-transport',
        message: `Using existing transport for ${this.path}.`,
        details: { portPath: this.path, timeoutMs: probeRuntimeTimeoutMs }
      });
      let runtimeInfo: PyDeviceRuntimeInfo | undefined;
      let reason: string | undefined;
      try {
        runtimeInfo = await this.transport.probeBoardRuntimeInfo(probeRuntimeTimeoutMs);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        emitPyDeviceLoggerEvent({
          source: 'ProbeDevices',
          level: 'debug',
          action: 'probe-runtime-failed',
          message: `Probe runtime failed on ${this.path}.`,
          details: { portPath: this.path, error: reason }
        });
      }

      if (!runtimeInfo) {
        runtimeInfo = await this.tryAggressiveRecoveryProbe(this.transport, probeRuntimeTimeoutMs);
      }

      this.emit({ type: 'runtimeInfo', path: this.path, runtimeInfo });
      return runtimeInfo ? { status: 'detected', runtimeInfo } : { status: 'noDevice', reason };
    }

    const transientTransport = this.transportFactory(this.path, this.baudRate, false);
    const startedAt = Date.now();
    let opened = false;
    let openTimedOut = false;
    let openPromise: Promise<void> | undefined;
    let deferredClosePromise: Promise<void> | undefined;
    try {
      emitPyDeviceLoggerEvent({
        source: 'ProbeDevices',
        level: 'debug',
        action: 'probe-open-started',
        message: `Opening serial port ${this.path} for probing.`,
        details: { portPath: this.path, timeoutMs: serialPortOperationTimeoutMs }
      });
      openPromise = transientTransport.open();
      await withTimeout(
        openPromise,
        serialPortOperationTimeoutMs,
        `Opening serial port ${this.path} for probing`
      );
      opened = true;
      emitPyDeviceLoggerEvent({
        source: 'ProbeDevices',
        level: 'debug',
        action: 'probe-open-completed',
        message: `Opened serial port ${this.path} for probing.`,
        details: { portPath: this.path, elapsedMs: Date.now() - startedAt }
      });

      emitPyDeviceLoggerEvent({
        source: 'ProbeDevices',
        level: 'debug',
        action: 'probe-runtime-started',
        message: `Starting runtime probe on ${this.path}.`,
        details: { portPath: this.path, timeoutMs: probeRuntimeTimeoutMs }
      });
      let runtimeInfo: PyDeviceRuntimeInfo | undefined;
      let runtimeReason: string | undefined;
      try {
        runtimeInfo = await transientTransport.probeBoardRuntimeInfo(probeRuntimeTimeoutMs);
        emitPyDeviceLoggerEvent({
          source: 'ProbeDevices',
          level: 'debug',
          action: 'probe-runtime-completed',
          message: `Completed runtime probe on ${this.path}.`,
          details: { portPath: this.path, elapsedMs: Date.now() - startedAt }
        });
      } catch (error) {
        runtimeReason = error instanceof Error ? error.message : String(error);
        emitPyDeviceLoggerEvent({
          source: 'ProbeDevices',
          level: 'debug',
          action: 'probe-runtime-failed',
          message: `Probe runtime failed on ${this.path}.`,
          details: { portPath: this.path, error: runtimeReason, elapsedMs: Date.now() - startedAt }
        });
      }

      if (!runtimeInfo) {
        runtimeInfo = await this.tryAggressiveRecoveryProbe(transientTransport, probeRuntimeTimeoutMs);
      }

      this.emit({ type: 'runtimeInfo', path: this.path, runtimeInfo });
      return runtimeInfo
        ? { status: 'detected', runtimeInfo }
        : { status: 'noDevice', reason: runtimeReason };
    } catch (error) {
      this.emit({ type: 'error', path: this.path, error });
      const reason = error instanceof Error ? error.message : String(error);
      openTimedOut = reason.includes(`timed out after ${serialPortOperationTimeoutMs}ms`);
      if (openTimedOut && openPromise) {
        deferredClosePromise = openPromise.then(async () => {
          try {
            emitPyDeviceLoggerEvent({
              source: 'ProbeDevices',
              level: 'debug',
              action: 'probe-timeout-cleanup-started',
              message: `Open eventually completed after timeout for ${this.path}; running deferred close.`,
              details: { portPath: this.path }
            });
            await transientTransport.close();
            emitPyDeviceLoggerEvent({
              source: 'ProbeDevices',
              level: 'debug',
              action: 'probe-timeout-cleanup-completed',
              message: `Deferred close completed for ${this.path}.`,
              details: { portPath: this.path }
            });
          } catch (cleanupError) {
            const cleanupReason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            emitPyDeviceLoggerEvent({
              source: 'ProbeDevices',
              level: 'debug',
              action: 'probe-timeout-cleanup-failed',
              message: `Deferred close failed for ${this.path}.`,
              details: { portPath: this.path, error: cleanupReason }
            });
          }
        }, () => {
          // If open eventually rejects, no deferred close is required.
        });
      }
      emitPyDeviceLoggerEvent({
        source: 'ProbeDevices',
        level: 'debug',
        action: 'probe-runtime-failed',
        message: `Probe runtime failed on ${this.path}.`,
        details: { portPath: this.path, error: reason, elapsedMs: Date.now() - startedAt }
      });
      return {
        status: openTimedOut ? 'unavailable' : 'noDevice',
        reason,
        waitingForCloseCompletion: !!deferredClosePromise,
        waitForCloseCompletion: deferredClosePromise
      };
    } finally {
      if (opened) {
        try {
          const closeStartedAt = Date.now();
          emitPyDeviceLoggerEvent({
            source: 'ProbeDevices',
            level: 'debug',
            action: 'probe-close-started',
            message: `Closing serial port ${this.path} after probing.`,
            details: { portPath: this.path, timeoutMs: serialPortOperationTimeoutMs }
          });
          await withTimeout(
            transientTransport.close(),
            serialPortOperationTimeoutMs,
            `Closing serial port ${this.path} after probing`
          );
          emitPyDeviceLoggerEvent({
            source: 'ProbeDevices',
            level: 'debug',
            action: 'probe-close-completed',
            message: `Closed serial port ${this.path} after probing.`,
            details: { portPath: this.path, elapsedMs: Date.now() - closeStartedAt }
          });
        } catch {
          // Ignore close failures for probe-only sessions.
          emitPyDeviceLoggerEvent({
            source: 'ProbeDevices',
            level: 'debug',
            action: 'probe-close-failed',
            message: `Failed to close serial port ${this.path} after probing.`,
            details: { portPath: this.path }
          });
        }
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

  private async tryAggressiveRecoveryProbe(
    transport: PyDeviceTransport,
    timeoutMs?: number
  ): Promise<PyDeviceRuntimeInfo | undefined> {
    const probeRuntimeTimeoutMs = resolveTimeoutMs(pyDeviceTimeoutSettings.pythonProbeRuntimeInfo, timeoutMs);
    const aggressiveProbeTimeoutMs = getTimeoutSettingMs(pyDeviceTimeoutSettings.serialPortAggressiveRecoveryProbe);
    const recoveryTimeoutMs = Math.max(probeRuntimeTimeoutMs, aggressiveProbeTimeoutMs);
    const startedAt = Date.now();
    emitPyDeviceLoggerEvent({
      source: 'ProbeDevices',
      level: 'debug',
      action: 'probe-recovery-started',
      message: `Starting aggressive soft-reboot recovery probe on ${this.path}.`,
      details: { portPath: this.path, timeoutMs: recoveryTimeoutMs }
    });

    try {
      const runtimeInfo = await transport.getBoardRuntimeInfo(recoveryTimeoutMs);
      emitPyDeviceLoggerEvent({
        source: 'ProbeDevices',
        level: 'debug',
        action: 'probe-recovery-completed',
        message: `Aggressive recovery probe succeeded on ${this.path}.`,
        details: { portPath: this.path, elapsedMs: Date.now() - startedAt }
      });
      return runtimeInfo;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emitPyDeviceLoggerEvent({
        source: 'ProbeDevices',
        level: 'debug',
        action: 'probe-recovery-failed',
        message: `Aggressive recovery probe failed on ${this.path}.`,
        details: { portPath: this.path, error: reason, elapsedMs: Date.now() - startedAt }
      });
      return undefined;
    }
  }

  private emit(event: DeviceSerialPortEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
