/**
 * Module overview:
 * This file is part of the Pydevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import { BoardRuntimeInfo, Pydevice } from '../utils/pydevice';
import { PortInfo } from '../utils/serial-port';

/**
 * Result of probing a serial port for MicroPython runtime details.
 */
export interface ProbedSerialDevice {
  port: PortInfo;
  runtimeInfo?: BoardRuntimeInfo;
}

/**
 * Small adapter around Pydevice probing so command code remains focused on UI
 * flow and can inject mock probing behavior in tests.
 */
export class SerialDeviceProber {
  constructor(private readonly baudRate: number) {}

  async probePort(port: PortInfo): Promise<ProbedSerialDevice | undefined> {
    const board = new Pydevice(port.path, this.baudRate, false);
    try {
      await board.open();
    } catch {
      return undefined;
    }

    try {
      const runtimeInfo = await board.probeBoardRuntimeInfo();
      return { port, runtimeInfo };
    } catch {
      return undefined;
    } finally {
      try {
        await board.close();
      } catch {
        // Ignore close errors during probing.
      }
    }
  }
}
