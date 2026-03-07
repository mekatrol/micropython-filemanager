import { PyDeviceState } from './py-device-state';

export interface PyDeviceControllerEvent {
  type: 'devicesChanged' | 'deviceUpdated';
  devices: PyDeviceState[];
  device?: PyDeviceState;
}
