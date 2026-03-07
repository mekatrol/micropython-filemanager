import { PortInfo } from '../utils/serial-port';
import { DeviceSerialPort } from './device-serial-port';
import { PyDeviceRuntimeInfo } from './py-device-runtime-info';
import { PyDeviceState } from './py-device-state';

export interface PyDeviceControllerOptions {
  baudRate?: number;
  monitorIntervalMs?: number;
  listPorts: () => Promise<PortInfo[]>;
  probeRuntimeInfo: (serialPort: DeviceSerialPort) => Promise<PyDeviceRuntimeInfo | undefined>;
  shouldProbePorts?: () => Promise<boolean> | boolean;
  readConfiguredState: () => Promise<Record<string, Omit<PyDeviceState, 'deviceId' | 'connectedSerialPortPath' | 'runtimeInfo'>>>;
  createSerialPort?: (path: string, baudRate: number) => DeviceSerialPort;
}
