import { PyDeviceRuntimeInfo } from './py-device-runtime-info';

export interface ConnectedPyDeviceSnapshot {
  deviceId: string;
  devicePath: string;
  baudRate: number;
  runtimeInfo: PyDeviceRuntimeInfo | undefined;
  executionCount: number;
}
