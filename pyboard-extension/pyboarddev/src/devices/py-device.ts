/**
 * Module overview:
 * This module provides abstraction for Python devices. It includes
 * transport-level serial communication and higher-level device state.
 */
import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { logChannelOutput } from '../output-channel';
import type {
  DeviceSerialPort,
  DeviceSerialPortEvent,
  Disposable,
  PyDeviceTransport
} from './device-serial-port';

export interface PyDeviceIOEvent {
  direction: 'tx' | 'rx';
  data: Buffer;
}

export interface PyDeviceRuntimeInfo {
  version: string;
  machine: string;
  uniqueId?: string;
  banner: string;
}

export class PyDeviceConnection {
  device: string;
  baudrate: number;
  user: string;
  password: string;

  inRawRepl: boolean = false;
  serialPort: SerialPort | undefined = undefined;
  nextCommand: string | undefined = undefined;

  useRawPaste: boolean = true;
  waitDelay: number = 100;
  private ioEmitter = new vscode.EventEmitter<PyDeviceIOEvent>();
  readonly onDidIO = this.ioEmitter.event;
  private execQueue: Promise<void> = Promise.resolve();
  private static readonly transportLogSettingKey = 'verboseReplTransportLogs';
  private static readonly writeAckTimeoutMs = 2000;
  private readonly reportErrorsToUser: boolean;

  constructor(
    device: string,
    baudrate: number = 115200,
    reportErrorsToUser: boolean = true,
    user: string = 'micro',
    password: string = 'python'
  ) {
    this.device = device;
    this.baudrate = baudrate;
    this.user = user;
    this.password = password;
    this.reportErrorsToUser = reportErrorsToUser;
  }

  async open(): Promise<void> {
    if (this.serialPort !== undefined) {
      await this.close();
    }

    this.serialPort = new SerialPort({
      path: this.device,
      baudRate: this.baudrate,
      autoOpen: false
    });

    const serialPort = this.serialPort;
    return new Promise((resolve, reject) => {
      serialPort.open((err) => {
        if (err) {
          reject(this.reportError('Failed to open serial port', err));
          return;
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.serialPort === undefined) {
      return;
    }

    const serialPort = this.serialPort;

    return new Promise((resolve, reject) => {
      serialPort.close((err) => {
        if (err) {
          reject(this.reportError('Failed to close serial port', err));
          return;
        }
        this.serialPort = undefined;
        resolve();
      });
    });
  }

  async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async enterRawRepl(): Promise<boolean> {
    await this.write('\r\x03');
    await this.delay(this.waitDelay);
    await this.readAll();
    await this.write('\r\x01');
    await this.delay(this.waitDelay);

    return await this.readUntil('raw REPL; CTRL-B to exit\r\n>');
  }

  async rawPasteWrite(commandBytes: number[]): Promise<boolean> {
    const header = await this.readNextRaw(2);
    const windowSize = header[0];
    let windowRemain = windowSize;

    let i = 0;
    while (i < commandBytes.length) {
      while (windowRemain === 0) {
        const data = await this.serialPort!.read(1);
        if (!data || data.length === 0) {
          continue;
        }

        switch (data[0]) {
          case 0x01:
            windowRemain += windowSize;
            continue;
          case 0x04:
            await this.write('\x04');
            continue;
          default:
            throw this.reportError('Unexpected byte during raw paste', new Error(String(data[0])));
        }
      }

      const bytes = commandBytes.slice(i, Math.min(i + windowRemain, commandBytes.length));
      this.emitIO('tx', Buffer.from(bytes));
      this.serialPort!.write(bytes);
      windowRemain -= bytes.length;
      i += bytes.length;
    }

    await this.delay(this.waitDelay);
    await this.readAllRaw();
    await this.write('\x04');
    await this.delay(this.waitDelay);

    const endResponse = await this.readNextRaw(1);
    if (endResponse[endResponse.length - 1] !== 0x04) {
      throw this.reportError('Raw paste did not complete successfully', new Error(String(endResponse)));
    }

    const data = await this.readAllRaw();
    const str = String.fromCharCode(...data.filter((b) => b !== 0x04));
    logChannelOutput(str, false);

    return true;
  }

  async execRawNoFollow(command: string | number[]): Promise<boolean> {
    let commandBytes: number[] = [];

    if (typeof command === 'string') {
      commandBytes = Array.from(command).map((c) => c.charCodeAt(0));
    } else {
      commandBytes = command;
    }

    if (this.useRawPaste) {
      await this.write('\x05A\x01');
      await this.delay(this.waitDelay);

      const response = await this.readNextRaw(2);
      if (response.length < 2 || response[0] !== 'R'.charCodeAt(0)) {
        this.useRawPaste = false;
      } else if (response[1] === 1) {
        return await this.rawPasteWrite(commandBytes);
      } else {
        this.useRawPaste = false;
      }
    }

    await this.write('\x04');
    await this.delay(this.waitDelay);

    const response2 = await this.readAllRaw();
    logChannelOutput(`Raw REPL fallback response: ${response2.join(',')}`, false);

    return true;
  }

  async exitRawRepl(): Promise<boolean> {
    await this.readAll();
    await this.write('\r\x02');
    await this.delay(this.waitDelay);

    return await this.readUntil('>>> ');
  }

  async readNextRaw(length: number): Promise<number[]> {
    this.assertPortOpen();
    const bytes = await this.serialPort!.read(length);
    if (bytes && bytes.length > 0) {
      this.emitIO('rx', Buffer.from(bytes));
    }
    return bytes ?? [];
  }

  async readNext(length: number): Promise<string> {
    const bytes = await this.readNextRaw(length);
    return bytes.length === 0 ? '' : String.fromCharCode(...bytes);
  }

  async readAllRaw(minLength: number = 1): Promise<number[]> {
    this.assertPortOpen();
    let response: number[] = [];

    while (true) {
      const bytes = await this.serialPort!.read(minLength);
      if (!bytes) {
        break;
      }
      this.emitIO('rx', Buffer.from(bytes));
      response = response.concat(...bytes);
    }

    return response;
  }

  async readAll(minLength: number = 1): Promise<string> {
    const bytes = await this.readAllRaw(minLength);
    return String.fromCharCode(...bytes);
  }

  async readUntil(str: string): Promise<boolean> {
    this.assertPortOpen();
    const response = await this.readAll();
    return response.slice(-str.length) === str;
  }

  async write(data: string, options?: { drain?: boolean }): Promise<void> {
    this.assertPortOpen();
    const drain = options?.drain !== false;

    const buffer = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      buffer[i] = data.charCodeAt(i);
    }
    this.emitIO('tx', Buffer.from(buffer));

    if (!drain) {
      // Fire-and-forget for control bytes. Some USB-serial bridges never invoke
      // write callbacks for these sequences, which can deadlock command flows.
      this.serialPort!.write(buffer);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const settleResolve = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      const timeout = setTimeout(() => {
        settleReject(this.reportError('Timed out waiting for serial write acknowledgement', new Error(`Timeout after ${PyDeviceConnection.writeAckTimeoutMs}ms`)));
      }, PyDeviceConnection.writeAckTimeoutMs);

      this.serialPort!.write(buffer, undefined, (err) => {
        if (err) {
          settleReject(this.reportError('Failed to write to serial port', err));
          return;
        }

        this.serialPort!.drain((drainError) => {
          if (drainError) {
            settleReject(this.reportError('Failed to flush serial write buffer', drainError));
            return;
          }

          settleResolve();
        });
      });
    });
  }

  async execRawCapture(command: string, timeoutMs: number = 10000): Promise<{ stdout: string; stderr: string }> {
    return this.enqueueExclusive(() => this.execRawCaptureUnlocked(command, timeoutMs));
  }

  private async execRawCaptureUnlocked(command: string, timeoutMs: number = 10000): Promise<{ stdout: string; stderr: string }> {
    this.assertPortOpen();

    await this.enterRawReplUnlocked(timeoutMs);

    await this.write(command);
    await this.write('\x04');

    const response = await this.waitForDataEndingWith(Buffer.from([0x04, 0x3e]), timeoutMs);

    await this.write('\r\x02', { drain: false });
    await this.readUntilIdle(100, 600);

    let payload = response;
    if (payload.length >= 2 && payload[0] === 'O'.charCodeAt(0) && payload[1] === 'K'.charCodeAt(0)) {
      payload = payload.slice(2);
    }

    const firstEot = payload.indexOf(0x04);
    if (firstEot < 0) {
      return { stdout: Buffer.from(payload).toString('utf8'), stderr: '' };
    }

    const stdoutBytes = payload.slice(0, firstEot);
    const remainder = payload.slice(firstEot + 1);
    const secondEot = remainder.lastIndexOf(0x04);
    const stderrBytes = secondEot >= 0 ? remainder.slice(0, secondEot) : remainder;

    return {
      stdout: Buffer.from(stdoutBytes).toString('utf8'),
      stderr: Buffer.from(stderrBytes).toString('utf8')
    };
  }

  async getBoardRuntimeInfo(timeoutMs: number = 5000): Promise<PyDeviceRuntimeInfo> {
    return this.enqueueExclusive(async () => {
      await this.softRebootRawUnlocked(Math.max(timeoutMs, 8000));
      const { stdout, stderr } = await this.execRawCaptureUnlocked(`${this.buildRuntimeInfoScript()}\n`, timeoutMs);
      const runtimeInfo = this.parseRuntimeInfo(stdout, stderr);
      runtimeInfo.uniqueId = await this.tryReadBoardUniqueIdUnlocked(timeoutMs);
      return runtimeInfo;
    });
  }

  async probeBoardRuntimeInfo(timeoutMs: number = 2500): Promise<PyDeviceRuntimeInfo> {
    return this.enqueueExclusive(async () => {
      const { stdout, stderr } = await this.execRawCaptureUnlocked(`${this.buildRuntimeInfoScript()}\n`, timeoutMs);
      const runtimeInfo = this.parseRuntimeInfo(stdout, stderr);
      runtimeInfo.uniqueId = await this.tryReadBoardUniqueIdUnlocked(timeoutMs);
      return runtimeInfo;
    });
  }

  async softReboot(timeoutMs: number = 8000): Promise<void> {
    return this.enqueueExclusive(async () => {
      await this.softRebootRawUnlocked(Math.max(timeoutMs, 1000));
    });
  }

  private buildRuntimeInfoScript(): string {
    const beginMarker = '__PYDEVICE_INFO_BEGIN__';
    const endMarker = '__PYDEVICE_INFO_END__';
    return [
      'try:',
      '  import os',
      'except:',
      '  import uos as os',
      'u = os.uname()',
      'try:',
      '  version = u.version',
      'except:',
      '  try:',
      '    version = u[3]',
      '  except:',
      "    version = ''",
      'try:',
      '  machine = u.machine',
      'except:',
      '  try:',
      '    machine = u[4]',
      '  except:',
      "    machine = ''",
      `print('${beginMarker}')`,
      'print(version)',
      'print(machine)',
      `print('${endMarker}')`
    ].join('\n');
  }

  private buildUniqueIdScript(): string {
    const beginMarker = '__PYDEVICE_UNIQUE_ID_BEGIN__';
    const endMarker = '__PYDEVICE_UNIQUE_ID_END__';
    return [
      `print('${beginMarker}')`,
      'uid = ""',
      'try:',
      '  import machine',
      '  try:',
      '    import ubinascii as binascii',
      '  except:',
      '    import binascii',
      '  uid = binascii.hexlify(machine.unique_id()).decode()',
      'except:',
      '  try:',
      '    import pyb',
      '    uid = pyb.unique_id()',
      '    if not isinstance(uid, str):',
      '      try:',
      '        import ubinascii as binascii',
      '      except:',
      '        import binascii',
      '      uid = binascii.hexlify(uid).decode()',
      '  except:',
      '    uid = ""',
      'print(uid)',
      `print('${endMarker}')`
    ].join('\n');
  }

  private parseRuntimeInfo(stdout: string, stderr: string): PyDeviceRuntimeInfo {
    if (stderr.trim().length > 0) {
      throw new Error(stderr.trim());
    }

    const beginMarker = '__PYDEVICE_INFO_BEGIN__';
    const endMarker = '__PYDEVICE_INFO_END__';
    const normalised = stdout.replace(/\r/g, '\n');
    const start = normalised.indexOf(beginMarker);
    const end = normalised.indexOf(endMarker);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(`Unexpected runtime info response: ${stdout}`);
    }

    const content = normalised
      .slice(start + beginMarker.length, end)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const version = content[0] ?? '';
    const machine = content[1] ?? '';
    if (!version || !machine) {
      throw new Error(`Incomplete runtime info response: ${stdout}`);
    }

    const banner = `${version}; ${machine}`;

    return {
      version,
      machine,
      banner
    };
  }

  private parseUniqueId(stdout: string, stderr: string): string {
    if (stderr.trim().length > 0) {
      throw new Error(stderr.trim());
    }

    const beginMarker = '__PYDEVICE_UNIQUE_ID_BEGIN__';
    const endMarker = '__PYDEVICE_UNIQUE_ID_END__';
    const normalised = stdout.replace(/\r/g, '\n');
    const start = normalised.indexOf(beginMarker);
    const end = normalised.indexOf(endMarker);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(`Unexpected unique ID response: ${stdout}`);
    }

    const content = normalised
      .slice(start + beginMarker.length, end)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return content[0] ?? '';
  }

  private async tryReadBoardUniqueIdUnlocked(timeoutMs: number): Promise<string | undefined> {
    try {
      const { stdout, stderr } = await this.execRawCaptureUnlocked(`${this.buildUniqueIdScript()}\n`, timeoutMs);
      const uniqueId = this.parseUniqueId(stdout, stderr);
      return uniqueId.length > 0 ? uniqueId : undefined;
    } catch {
      return undefined;
    }
  }

  private async softRebootRawUnlocked(timeoutMs: number): Promise<void> {
    await this.enterRawReplUnlocked(timeoutMs);

    const rawPromptText = Buffer.from('raw REPL; CTRL-B to exit');
    const softRebootText = Buffer.from('soft reboot');

    await this.write('\x04');
    await this.waitForDataContains([softRebootText, rawPromptText], timeoutMs);

    await this.write('\r\x02', { drain: false });
    await this.readUntilIdle(120, 800);
  }

  private async enterRawReplUnlocked(timeoutMs: number): Promise<void> {
    const rawPromptText = Buffer.from('raw REPL; CTRL-B to exit');
    const rawPromptPrefix = Buffer.from('raw REPL');
    const rawPromptTail = Buffer.from('\r\n>');
    const attempts = timeoutMs < 5000 ? 2 : 3;
    const startedAt = Date.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, timeoutMs - elapsedMs);
      if (remainingMs <= 0) {
        break;
      }
      const attemptsLeft = attempts - attempt + 1;
      const promptTimeoutMs = Math.min(remainingMs, Math.max(1500, Math.floor(remainingMs / attemptsLeft)));

      try {
        await this.write('\r\x03\x03', { drain: false });
        await this.readUntilIdle(120, 800);

        await this.write('\r\x01', { drain: false });
        await this.waitForDataContains([rawPromptText, rawPromptPrefix, rawPromptTail], promptTimeoutMs);
        return;
      } catch (error) {
        lastError = error;
        await this.readUntilIdle(120, 600);
        if (attempt < attempts) {
          await this.delay(120);
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : this.reportError('Failed to enter raw REPL', new Error(String(lastError)));
  }

  private async waitForDataContains(patterns: Buffer[], timeoutMs: number): Promise<number[]> {
    this.assertPortOpen();

    const bytes: number[] = [];
    return await new Promise<number[]>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.emitIO('rx', chunk);
        for (const value of chunk.values()) {
          bytes.push(value);
        }

        const buffer = Buffer.from(bytes);
        for (const pattern of patterns) {
          if (buffer.indexOf(pattern) >= 0) {
            cleanup();
            resolve(bytes);
            return;
          }
        }
      };

      const onError = (error: Error) => {
        cleanup();
        reject(this.reportError('Serial read failed while waiting for prompt', error));
      };

      const onTimeout = () => {
        cleanup();
        reject(
          this.reportError(
            `Timed out waiting for serial response containing ${patterns.map((item) => JSON.stringify(Array.from(item.values()))).join(', ')}`,
            new Error(`Timeout after ${timeoutMs}ms`)
          )
        );
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.serialPort!.off('data', onData);
        this.serialPort!.off('error', onError);
      };

      const timer = setTimeout(onTimeout, timeoutMs);
      this.serialPort!.on('data', onData);
      this.serialPort!.on('error', onError);
    });
  }

  private async waitForDataEndingWith(suffix: Buffer, timeoutMs: number): Promise<number[]> {
    this.assertPortOpen();

    const bytes: number[] = [];
    return await new Promise<number[]>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.emitIO('rx', chunk);
        for (const value of chunk.values()) {
          bytes.push(value);
        }

        if (bytes.length < suffix.length) {
          return;
        }

        const start = bytes.length - suffix.length;
        for (let i = 0; i < suffix.length; i += 1) {
          if (bytes[start + i] !== suffix[i]) {
            return;
          }
        }

        cleanup();
        resolve(bytes.slice(0, -suffix.length));
      };

      const onError = (error: Error) => {
        cleanup();
        reject(this.reportError('Serial read failed while waiting for command response', error));
      };

      const onTimeout = () => {
        cleanup();
        reject(
          this.reportError(
            `Timed out waiting for serial response suffix ${JSON.stringify(Array.from(suffix.values()))}`,
            new Error(`Timeout after ${timeoutMs}ms`)
          )
        );
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.serialPort!.off('data', onData);
        this.serialPort!.off('error', onError);
      };

      const timer = setTimeout(onTimeout, timeoutMs);
      this.serialPort!.on('data', onData);
      this.serialPort!.on('error', onError);
    });
  }

  private async readUntilIdle(idleMs: number, maxMs: number): Promise<void> {
    this.assertPortOpen();

    await new Promise<void>((resolve) => {
      let idleTimer: NodeJS.Timeout | undefined;
      let maxTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }

        if (maxTimer) {
          clearTimeout(maxTimer);
        }

        this.serialPort!.off('data', onData);
        this.serialPort!.off('error', onError);
      };

      const finish = () => {
        cleanup();
        resolve();
      };

      const onData = (chunk: Buffer) => {
        this.emitIO('rx', chunk);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }

        idleTimer = setTimeout(finish, idleMs);
      };

      const onError = () => {
        finish();
      };

      idleTimer = setTimeout(finish, idleMs);
      maxTimer = setTimeout(finish, maxMs);

      this.serialPort!.on('data', onData);
      this.serialPort!.on('error', onError);
    });
  }

  assertPortOpen() {
    if (!this.serialPort) {
      throw new Error('The serial port must be open to call this method');
    }
  }

  private reportError(context: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${context}: ${detail}`;
    if (this.reportErrorsToUser && this.shouldSurfaceErrorToUser(message)) {
      vscode.window.showErrorMessage(message);
    }
    logChannelOutput(message, true);
    return new Error(message);
  }

  private shouldSurfaceErrorToUser(message: string): boolean {
    // These transport timeouts are expected during probing/retries and should
    // be surfaced in row status instead of repeated global pop-up errors.
    if (message.includes('Timed out waiting for serial response containing')) {
      return false;
    }
    return true;
  }

  private emitIO(direction: 'tx' | 'rx', data: Buffer): void {
    if (data.length === 0) {
      return;
    }

    this.ioEmitter.fire({ direction, data });
    console.debug(`[REPL ${direction.toUpperCase()}] ${this.formatBytesForLog(data)}`);
    if (this.isTransportLoggingEnabled()) {
      logChannelOutput(`[REPL ${direction.toUpperCase()}] ${this.formatBytesForLog(data)}`, false);
    }
  }

  private isTransportLoggingEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('mekatrol.pydevice')
      .get<boolean>(PyDeviceConnection.transportLogSettingKey, false);
  }

  private formatBytesForLog(data: Buffer): string {
    let output = '';
    for (const value of data.values()) {
      if (value === 10) {
        output += '\\n';
        continue;
      }

      if (value === 13) {
        output += '\\r';
        continue;
      }

      if (value >= 32 && value <= 126) {
        output += String.fromCharCode(value);
        continue;
      }

      output += `\\x${value.toString(16).padStart(2, '0')}`;
    }

    return output;
  }

  private async enqueueExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.execQueue.then(fn, fn);
    this.execQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export interface PyDeviceState {
  deviceId: string;
  name?: string;
  hostFolder?: string;
  libraryFolders: string[];
  syncExcludedPaths: string[];
  lastKnownSerialPortPath?: string;
  connectedSerialPortPath?: string;
  runtimeInfo?: PyDeviceRuntimeInfo;
}

export type PyDeviceEvent =
  | { type: 'updated'; state: PyDeviceState }
  | { type: 'connected'; state: PyDeviceState }
  | { type: 'disconnected'; state: PyDeviceState }
  | { type: 'runtimeInfo'; state: PyDeviceState; runtimeInfo: PyDeviceRuntimeInfo | undefined }
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
  private _runtimeInfo: PyDeviceRuntimeInfo | undefined;

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

  get runtimeInfo(): PyDeviceRuntimeInfo | undefined {
    return this._runtimeInfo;
  }

  get isConnected(): boolean {
    return !!this._serialPort?.isConnected;
  }

  get activeTransport(): PyDeviceTransport | undefined {
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
