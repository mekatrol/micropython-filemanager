import { PortInfo } from '../utils/serial-port';
import { PyDeviceRuntimeInfo } from './py-device-runtime-info';

export interface ProbedSerialDevice {
  port: PortInfo;
  runtimeInfo?: PyDeviceRuntimeInfo;
}
