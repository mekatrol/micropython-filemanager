import { PyDeviceRuntimeInfo } from './py-device-runtime-info';

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
