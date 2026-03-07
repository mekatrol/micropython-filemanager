import * as assert from 'assert';
import { BoardRuntimeInfo } from '../../utils/pydevice';
import { DeviceSerialPort, PydeviceTransport } from '../../devices/device-serial-port';

class FakeTransport implements PydeviceTransport {
  opened = false;

  constructor(
    public readonly device: string,
    public readonly baudrate: number,
    private readonly runtimeInfo: BoardRuntimeInfo | undefined = undefined
  ) {}

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async probeBoardRuntimeInfo(): Promise<BoardRuntimeInfo | undefined> {
    return this.runtimeInfo;
  }

  async getBoardRuntimeInfo(): Promise<BoardRuntimeInfo | undefined> {
    return this.runtimeInfo;
  }

  async softReboot(): Promise<void> {
    return;
  }
}

suite('DeviceSerialPort', () => {
  test('emits connected and disconnected events', async () => {
    const events: string[] = [];
    const serialPort = new DeviceSerialPort(
      '/dev/ttyUSB0',
      115200,
      false,
      (path, baudRate) => new FakeTransport(path, baudRate)
    );
    serialPort.onDidChange((event) => events.push(event.type));

    await serialPort.connect();
    await serialPort.disconnect();

    assert.deepStrictEqual(events, ['connected', 'disconnected']);
  });

  test('can probe runtime info through transient transport', async () => {
    const runtimeInfo: BoardRuntimeInfo = {
      runtimeName: 'MicroPython',
      version: '1.23.0',
      machine: 'ESP32',
      uniqueId: 'abc123',
      banner: 'MicroPython'
    };
    const serialPort = new DeviceSerialPort(
      '/dev/ttyUSB0',
      115200,
      false,
      (path, baudRate) => new FakeTransport(path, baudRate, runtimeInfo)
    );

    const result = await serialPort.probeRuntimeInfo();
    assert.strictEqual(result?.uniqueId, 'abc123');
    assert.strictEqual(serialPort.isConnected, false);
  });
});

