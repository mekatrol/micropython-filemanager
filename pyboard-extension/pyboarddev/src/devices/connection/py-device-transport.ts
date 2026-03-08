import { PyDeviceRuntimeInfo } from '../model/py-device-runtime-info';

export interface PyDeviceTransport {
  device: string;
  baudrate: number;
  open(): Promise<void>;
  close(): Promise<void>;
  probeBoardRuntimeInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo | undefined>;
  getBoardRuntimeInfo(timeoutMs?: number): Promise<PyDeviceRuntimeInfo | undefined>;
  softReboot(): Promise<void>;
}
