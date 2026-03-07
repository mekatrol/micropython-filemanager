/**
 * Module overview:
 * Probes serial ports and returns runtime metadata for ports that respond
 * as supported Python devices.
 */
import { MicroPythonDevice } from './py-device';
import { PortInfo } from '../utils/serial-port';
import { DeviceSerialPort } from './device-serial-port';
import { ProbedSerialDevice } from './probed-serial-device';

/**
 * Small adapter around Python-device probing so command code remains focused on UI
 * flow and can inject mock probing behavior in tests.
 */
export class SerialDeviceProber {
  constructor(private readonly baudRate: number) {}

  async probePort(port: PortInfo): Promise<ProbedSerialDevice | undefined> {
    const serialPort = new DeviceSerialPort(
      port.path,
      this.baudRate,
      false,
      (devicePath, baudRate) => new MicroPythonDevice(devicePath, baudRate, false)
    );
    const runtimeInfo = await serialPort.probeRuntimeInfo();
    return runtimeInfo ? { port, runtimeInfo } : undefined;
  }
}

export type { ProbedSerialDevice };
