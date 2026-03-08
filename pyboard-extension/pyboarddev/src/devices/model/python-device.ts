import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { PyDeviceRuntimeInfo } from './py-device-runtime-info';

export interface PythonDevice {
  device: string;
  baudrate: number;
  readonly onDidReceiveData: vscode.Event<Buffer>;
  readonly onDidDisconnect: vscode.Event<void>;
  connect(serialPort: SerialPort): Promise<void>;
  disconnect(): Promise<void>;
  softReboot(timeoutMs?: number): Promise<void>;
  hardReboot(timeoutMs?: number): Promise<void>;
  sendText(text: string, options?: { drain?: boolean }): Promise<void>;
  getDeviceInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo>;
  probeDeviceInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo>;
  execute(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  open(): Promise<void>;
  close(): Promise<void>;
  probeBoardRuntimeInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo>;
  getBoardRuntimeInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo>;
  write(data: string, options?: { drain?: boolean }): Promise<void>;
  execRawCapture(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
}
