import { PyDeviceState } from '../model/py-device-state';

export interface PyDeviceControllerEvent {
  type: 'devicesChanged' | 'deviceUpdated';
  devices: PyDeviceState[];
  device?: PyDeviceState;
}
