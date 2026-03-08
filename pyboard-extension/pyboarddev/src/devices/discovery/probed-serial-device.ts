import { PortInfo } from '../../utils/serial-port';
import { PyDeviceRuntimeInfo } from '../model/py-device-runtime-info';

export type ProbedSerialDeviceStatus = 'detected' | 'noDevice' | 'unavailable';

export interface ProbedSerialDevice {
  port: PortInfo;
  status: ProbedSerialDeviceStatus;
  runtimeInfo?: PyDeviceRuntimeInfo;
  reason?: string;
  waitingForCloseCompletion?: boolean;
  waitForCloseCompletion?: Promise<void>;
}
