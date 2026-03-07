import { PyDeviceRuntimeInfo } from '../devices/py-device';

export enum ConnectStatus {
  Ready = 'ready',
  Connecting = 'connecting',
  Connected = 'connected',
  NotConnected = 'not_connected',
  Error = 'error'
}

export interface ConnectRow {
  id: string;
  devicePath: string;
  serialPortName: string;
  deviceId: string;
  deviceName: string;
  status: ConnectStatus;
  errorText?: string;
  deviceInfo?: string;
  details?: string;
}

export const toDeviceInfoSummary = (runtimeInfo: PyDeviceRuntimeInfo | undefined): string | undefined => {
  if (!runtimeInfo) {
    return undefined;
  }

  return `${runtimeInfo.version}; ${runtimeInfo.machine}`;
};
