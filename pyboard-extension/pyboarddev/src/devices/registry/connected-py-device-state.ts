import { PyDeviceConnection } from '../connection/py-device-connection';
import { PyDeviceRuntimeInfo } from '../model/py-device-runtime-info';

export interface ConnectedPyDeviceState {
  deviceId: string;
  board: PyDeviceConnection;
  runtimeInfo: PyDeviceRuntimeInfo | undefined;
  executionCount: number;
}
