/**
 * Module overview:
 * This module provides abstraction for a python device. It allows separation of Python devices from the
 * extension components and functionality. It implements a publish / subscribe model so that other functions 
 * and features can listen to Python device events. 
 */
import { BoardRuntimeInfo } from '../utils/pydevice';
import { DeviceSerialPort, DeviceSerialPortEvent, Disposable, PydeviceTransport } from './device-serial-port';

export interface PyDeviceState {
  deviceId: string;
  name?: string;
  hostFolder?: string;
  libraryFolders: string[];
  syncExcludedPaths: string[];
  lastKnownSerialPortPath?: string;
  connectedSerialPortPath?: string;
  runtimeInfo?: BoardRuntimeInfo;
}

export type PyDeviceEvent =
  | { type: 'updated'; state: PyDeviceState }
  | { type: 'connected'; state: PyDeviceState }
  | { type: 'disconnected'; state: PyDeviceState }
  | { type: 'runtimeInfo'; state: PyDeviceState; runtimeInfo: BoardRuntimeInfo | undefined }
  | { type: 'error'; state: PyDeviceState; error: unknown };

type PyDeviceListener = (event: PyDeviceEvent) => void;

export class PyDevice {
  readonly key: string;
  private readonly listeners = new Set<PyDeviceListener>();
  private serialPortSubscription: Disposable | undefined;
  private _name: string | undefined;
  private _hostFolder: string | undefined;
  private _libraryFolders: string[];
  private _syncExcludedPaths: string[];
  private _lastKnownSerialPortPath: string | undefined;
  private _serialPort: DeviceSerialPort | undefined;
  private _runtimeInfo: BoardRuntimeInfo | undefined;

  constructor(state: Omit<PyDeviceState, 'connectedSerialPortPath' | 'runtimeInfo'>) {
    this.key = state.deviceId;
    this._name = state.name?.trim() || undefined;
    this._hostFolder = state.hostFolder?.trim() || undefined;
    this._libraryFolders = [...state.libraryFolders];
    this._syncExcludedPaths = [...state.syncExcludedPaths];
    this._lastKnownSerialPortPath = state.lastKnownSerialPortPath?.trim() || undefined;
  }

  get deviceId(): string {
    return this.key;
  }

  get name(): string | undefined {
    return this._name;
  }

  get hostFolder(): string | undefined {
    return this._hostFolder;
  }

  get libraryFolders(): string[] {
    return [...this._libraryFolders];
  }

  get syncExcludedPaths(): string[] {
    return [...this._syncExcludedPaths];
  }

  get lastKnownSerialPortPath(): string | undefined {
    return this._lastKnownSerialPortPath;
  }

  get serialPort(): DeviceSerialPort | undefined {
    return this._serialPort;
  }

  get runtimeInfo(): BoardRuntimeInfo | undefined {
    return this._runtimeInfo;
  }

  get isConnected(): boolean {
    return !!this._serialPort?.isConnected;
  }

  get activeTransport(): PydeviceTransport | undefined {
    return this._serialPort?.getTransport();
  }

  onDidChange(listener: PyDeviceListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  }

  setName(name: string | undefined): void {
    this._name = name?.trim() || undefined;
    this.emitUpdated();
  }

  setHostFolder(hostFolder: string | undefined): void {
    this._hostFolder = hostFolder?.trim() || undefined;
    this.emitUpdated();
  }

  setLibraryFolders(libraryFolders: string[]): void {
    this._libraryFolders = [...libraryFolders];
    this.emitUpdated();
  }

  setSyncExcludedPaths(syncExcludedPaths: string[]): void {
    this._syncExcludedPaths = [...syncExcludedPaths];
    this.emitUpdated();
  }

  setLastKnownSerialPortPath(serialPortPath: string | undefined): void {
    this._lastKnownSerialPortPath = serialPortPath?.trim() || undefined;
    this.emitUpdated();
  }

  attachSerialPort(serialPort: DeviceSerialPort | undefined): void {
    if (this._serialPort === serialPort) {
      return;
    }

    this.serialPortSubscription?.dispose();
    this.serialPortSubscription = undefined;
    this._serialPort = serialPort;
    if (serialPort) {
      this._lastKnownSerialPortPath = serialPort.path;
      this.serialPortSubscription = serialPort.onDidChange((event) => this.onSerialPortEvent(event));
    }
    this.emitUpdated();
  }

  async connect(): Promise<void> {
    if (!this._serialPort) {
      throw new Error(`No serial port mapped for device ${this.deviceId}`);
    }

    await this._serialPort.connect();
    this._lastKnownSerialPortPath = this._serialPort.path;
    this.emit({ type: 'connected', state: this.toState() });
  }

  async disconnect(): Promise<void> {
    if (!this._serialPort) {
      return;
    }

    await this._serialPort.disconnect();
    this.emit({ type: 'disconnected', state: this.toState() });
  }

  toState(): PyDeviceState {
    return {
      deviceId: this.deviceId,
      name: this._name,
      hostFolder: this._hostFolder,
      libraryFolders: [...this._libraryFolders],
      syncExcludedPaths: [...this._syncExcludedPaths],
      lastKnownSerialPortPath: this._lastKnownSerialPortPath,
      connectedSerialPortPath: this._serialPort?.isConnected ? this._serialPort.path : undefined,
      runtimeInfo: this._runtimeInfo
    };
  }

  private onSerialPortEvent(event: DeviceSerialPortEvent): void {
    if (event.type === 'connected') {
      this._lastKnownSerialPortPath = event.path;
      this.emit({ type: 'connected', state: this.toState() });
      return;
    }

    if (event.type === 'disconnected') {
      this.emit({ type: 'disconnected', state: this.toState() });
      return;
    }

    if (event.type === 'runtimeInfo') {
      this._runtimeInfo = event.runtimeInfo;
      this.emit({ type: 'runtimeInfo', state: this.toState(), runtimeInfo: event.runtimeInfo });
      return;
    }

    this.emit({ type: 'error', state: this.toState(), error: event.error });
  }

  private emitUpdated(): void {
    this.emit({ type: 'updated', state: this.toState() });
  }

  private emit(event: PyDeviceEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

