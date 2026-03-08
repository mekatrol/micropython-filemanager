/**
 * Module overview:
 * Probes serial ports and returns runtime metadata for ports that respond
 * as supported Python devices.
 */
import { MicroPythonDevice } from '../py-device';
import { PortInfo } from '../../utils/serial-port';
import { DeviceSerialPort } from '../connection/device-serial-port';
import { ProbedSerialDevice } from './probed-serial-device';

/**
 * Small adapter around Python-device probing so command code remains focused on UI
 * flow and can inject mock probing behavior in tests.
 */
export class SerialDeviceProber {
  constructor(private readonly baudRate: number) {}

  async probePort(port: PortInfo): Promise<ProbedSerialDevice> {
    const serialPort = new DeviceSerialPort(
      port.path,
      this.baudRate,
      false,
      (devicePath, baudRate) => new MicroPythonDevice(devicePath, baudRate, false)
    );
    const probeResult = await serialPort.probeRuntimeInfoDetailed();
    return {
      port,
      status: probeResult.status,
      runtimeInfo: probeResult.runtimeInfo,
      reason: probeResult.reason,
      waitingForCloseCompletion: probeResult.waitingForCloseCompletion,
      waitForCloseCompletion: probeResult.waitForCloseCompletion
    };
  }
}

export type { ProbedSerialDevice };
