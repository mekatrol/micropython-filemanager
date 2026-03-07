import * as assert from 'assert';
import { DeviceSerialPort } from '../../devices/device-serial-port';
import { PyDevice } from '../../devices/device';

suite('PyDevice', () => {
  test('forwards serial port connect and disconnect events', async () => {
    const pyDevice = new PyDevice({
      deviceId: 'dev-1',
      name: 'Board 1',
      hostFolder: 'src',
      libraryFolders: ['lib'],
      syncExcludedPaths: ['build']
    });
    const eventTypes: string[] = [];
    pyDevice.onDidChange((event) => eventTypes.push(event.type));

    const serialPort = new DeviceSerialPort('/dev/ttyUSB0', 115200, false, () => ({
      device: '/dev/ttyUSB0',
      baudrate: 115200,
      async open() { return; },
      async close() { return; },
      async probeBoardRuntimeInfo() { return undefined; },
      async getBoardRuntimeInfo() { return undefined; },
      async softReboot() { return; }
    }));

    pyDevice.attachSerialPort(serialPort);
    await pyDevice.connect();
    await pyDevice.disconnect();

    assert.ok(eventTypes.includes('connected'));
    assert.ok(eventTypes.includes('disconnected'));
    assert.strictEqual(pyDevice.lastKnownSerialPortPath, '/dev/ttyUSB0');
  });
});

