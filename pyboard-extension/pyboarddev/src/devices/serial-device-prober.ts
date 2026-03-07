/**
 * Module overview:
 * Probes serial ports and returns runtime metadata for ports that respond
 * as supported Python devices.
 */
import { PyDeviceConnection, PyDeviceRuntimeInfo } from './py-device';
import { PortInfo } from '../utils/serial-port';
import { DeviceSerialPort } from './device-serial-port';

/**
 * Result of probing a serial port for runtime details.
 */
export interface ProbedSerialDevice {
  port: PortInfo;
  runtimeInfo?: PyDeviceRuntimeInfo;
}

/**
 * Small adapter around PyDevice probing so command code remains focused on UI
 * flow and can inject mock probing behavior in tests.
 */
export class SerialDeviceProber {
  constructor(private readonly baudRate: number) {}

  async probePort(port: PortInfo): Promise<ProbedSerialDevice | undefined> {
    const serialPort = new DeviceSerialPort(
      port.path,
      this.baudRate,
      false,
      (devicePath, baudRate) => new PyDeviceConnection(devicePath, baudRate, false)
    );
    const runtimeInfo = await serialPort.probeRuntimeInfo();
    return runtimeInfo ? { port, runtimeInfo } : undefined;
  }
}
