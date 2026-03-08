import { PortInfo } from '../../utils/serial-port';
import { DeviceSerialPort } from '../connection/device-serial-port';
import { PyDeviceRuntimeInfo } from '../model/py-device-runtime-info';
import { PyDeviceState } from '../model/py-device-state';

export interface PyDeviceControllerOptions {
  baudRate?: number;
  monitorIntervalMs?: number;
  listPorts: () => Promise<PortInfo[]>;
  probeRuntimeInfo: (serialPort: DeviceSerialPort) => Promise<PyDeviceRuntimeInfo | undefined>;
  shouldProbePorts?: () => Promise<boolean> | boolean;
  readConfiguredState: () => Promise<Record<string, Omit<PyDeviceState, 'deviceId' | 'connectedSerialPortPath' | 'runtimeInfo'>>>;
  createSerialPort?: (path: string, baudRate: number) => DeviceSerialPort;
}
