/**
 * Module overview:
 * Discovers available ports, maps them to logical devices, and publishes
 * device list/state change events.
 */
import { toDeviceId } from '../identity/device-id';
import { DeviceSerialPort, Disposable } from '../connection/device-serial-port';
import { PyDevice, PyDeviceState } from '../py-device';
import { PyDeviceControllerEvent } from './py-device-controller-event';
import { PyDeviceControllerOptions } from './py-device-controller-options';

type PyDeviceControllerListener = (event: PyDeviceControllerEvent) => void;

export class PyDeviceController {
  private readonly listeners = new Set<PyDeviceControllerListener>();
  private readonly devicesById = new Map<string, PyDevice>();
  private readonly deviceSubscriptionById = new Map<string, Disposable>();
  private readonly baudRate: number;
  private readonly monitorIntervalMs: number;
  private readonly createSerialPort: (path: string, baudRate: number) => DeviceSerialPort;
  private monitorHandle: NodeJS.Timeout | undefined;
  private reconcileInProgress = false;
  private reconcileQueued = false;

  constructor(private readonly options: PyDeviceControllerOptions) {
    this.baudRate = options.baudRate ?? 115200;
    this.monitorIntervalMs = options.monitorIntervalMs ?? 2000;
    this.createSerialPort = options.createSerialPort ?? ((path, baudRate) => new DeviceSerialPort(path, baudRate, false));
  }

  onDidChange(listener: PyDeviceControllerListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  }

  getDevices(): PyDevice[] {
    return [...this.devicesById.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  getDevice(deviceId: string): PyDevice | undefined {
    return this.devicesById.get(deviceId);
  }

  async initialise(): Promise<void> {
    const configuredStateByDeviceId = await this.options.readConfiguredState();
    const sortedDeviceIds = Object.keys(configuredStateByDeviceId).sort((a, b) => a.localeCompare(b));
    for (const deviceId of sortedDeviceIds) {
      const state = configuredStateByDeviceId[deviceId];
      this.upsertDevice(new PyDevice({
        deviceId,
        name: state.name,
        hostFolder: state.hostFolder,
        libraryFolders: state.libraryFolders ?? [],
        syncExcludedPaths: state.syncExcludedPaths ?? [],
        lastKnownSerialPortPath: state.lastKnownSerialPortPath
      }));
    }
    this.emitDevicesChanged();
    await this.reconcileNow();
  }

  startMonitoring(): void {
    if (this.monitorHandle) {
      return;
    }
    this.monitorHandle = setInterval(() => {
      void this.reconcileNow();
    }, this.monitorIntervalMs);
  }

  stopMonitoring(): void {
    if (!this.monitorHandle) {
      return;
    }
    clearInterval(this.monitorHandle);
    this.monitorHandle = undefined;
  }

  async reconcileNow(): Promise<void> {
    if (this.reconcileInProgress) {
      this.reconcileQueued = true;
      return;
    }
    this.reconcileInProgress = true;
    try {
      await this.reconcileCore();
    } finally {
      this.reconcileInProgress = false;
      if (this.reconcileQueued) {
        this.reconcileQueued = false;
        await this.reconcileNow();
      }
    }
  }

  private async reconcileCore(): Promise<void> {
    const shouldProbePorts = await this.options.shouldProbePorts?.() ?? true;
    if (!shouldProbePorts) {
      for (const device of this.devicesById.values()) {
        if (device.serialPort) {
          device.attachSerialPort(undefined);
        }
      }
      this.emitDevicesChanged();
      return;
    }

    const ports = await this.options.listPorts();
    const nextPortPaths = new Set(ports.map((port) => port.path));
    const deviceByConnectedPath = new Map<string, PyDevice>();

    for (const device of this.devicesById.values()) {
      if (device.serialPort) {
        deviceByConnectedPath.set(device.serialPort.path, device);
      }
    }

    for (const port of ports) {
      const serialPort = this.createSerialPort(port.path, this.baudRate);
      const runtimeInfo = await this.options.probeRuntimeInfo(serialPort);
      const probedDeviceId = toDeviceId(port.path, runtimeInfo);
      const existing = deviceByConnectedPath.get(port.path);

      if (existing && existing.deviceId === probedDeviceId) {
        existing.attachSerialPort(serialPort);
        continue;
      }

      if (existing && existing.deviceId !== probedDeviceId) {
        existing.attachSerialPort(undefined);
      }

      const knownDevice = this.devicesById.get(probedDeviceId);
      if (knownDevice) {
        knownDevice.attachSerialPort(serialPort);
        continue;
      }

      const created = new PyDevice({
        deviceId: probedDeviceId,
        libraryFolders: [],
        syncExcludedPaths: [],
        lastKnownSerialPortPath: port.path
      });

      created.attachSerialPort(serialPort);
      this.upsertDevice(created);
    }

    for (const device of this.devicesById.values()) {
      const serialPath = device.serialPort?.path;
      if (!serialPath) {
        continue;
      }
      if (!nextPortPaths.has(serialPath)) {
        device.attachSerialPort(undefined);
      }
    }

    this.emitDevicesChanged();
  }

  private upsertDevice(device: PyDevice): void {
    if (this.devicesById.has(device.deviceId)) {
      return;
    }
    this.devicesById.set(device.deviceId, device);
    const subscription = device.onDidChange((event) => {
      this.emit({
        type: 'deviceUpdated',
        devices: this.toDeviceStates(),
        device: event.state
      });
    });
    this.deviceSubscriptionById.set(device.deviceId, subscription);
  }

  private toDeviceStates(): PyDeviceState[] {
    return this.getDevices().map((device) => device.toState());
  }

  private emitDevicesChanged(): void {
    this.emit({
      type: 'devicesChanged',
      devices: this.toDeviceStates()
    });
  }

  private emit(event: PyDeviceControllerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export type { PyDeviceControllerEvent, PyDeviceControllerOptions };
