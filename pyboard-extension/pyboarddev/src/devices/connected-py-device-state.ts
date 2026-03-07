import { PyDeviceConnection } from './py-device-connection';
import { PyDeviceRuntimeInfo } from './py-device-runtime-info';

export interface ConnectedPyDeviceState {
  deviceId: string;
  board: PyDeviceConnection;
  runtimeInfo: PyDeviceRuntimeInfo | undefined;
  executionCount: number;
}
