import * as assert from 'assert';
import { DeviceSerialPort } from '../../devices/connection/device-serial-port';
import { PyDeviceController } from '../../devices/controller/py-device-controller';
import { PyDeviceRuntimeInfo } from '../../devices/py-device';

suite('PyDeviceController', () => {
  test('remaps same serial port to a different probed device ID', async () => {
    let currentPortList = [{ path: '/dev/ttyUSB0', vendorId: '1111', productId: '2222' }];
    let currentUniqueId = 'device-A';

    const controller = new PyDeviceController({
      listPorts: async () => currentPortList,
      probeRuntimeInfo: async () => ({
        version: '1.23.0',
        machine: 'ESP32',
        uniqueId: currentUniqueId,
        banner: '1.23.0; ESP32'
      }),
      readConfiguredState: async () => ({})
    });

    await controller.initialise();
    let states = controller.getDevices().map((item) => item.toState());
    assert.deepStrictEqual(states.map((item) => item.deviceId), ['device-A']);
    assert.strictEqual(states[0].connectedSerialPortPath, undefined);
    assert.strictEqual(states[0].lastKnownSerialPortPath, '/dev/ttyUSB0');

    currentUniqueId = 'device-B';
    await controller.reconcileNow();
    states = controller.getDevices().map((item) => item.toState());

    assert.deepStrictEqual(states.map((item) => item.deviceId), ['device-A', 'device-B']);
    const deviceA = states.find((item) => item.deviceId === 'device-A');
    const deviceB = states.find((item) => item.deviceId === 'device-B');
    assert.ok(deviceA);
    assert.ok(deviceB);
    assert.strictEqual(deviceA?.connectedSerialPortPath, undefined);
    assert.strictEqual(deviceB?.lastKnownSerialPortPath, '/dev/ttyUSB0');
  });

  test('keeps configured device metadata and attaches matching port by device ID', async () => {
    const runtimeByPath = new Map<string, PyDeviceRuntimeInfo>([
      ['/dev/ttyUSB2', {
        version: '1.23.0',
        machine: 'ESP32',
        uniqueId: 'configured-1',
        banner: '1.23.0; ESP32'
      }]
    ]);

    const controller = new PyDeviceController({
      listPorts: async () => [{ path: '/dev/ttyUSB2', vendorId: 'aaaa', productId: 'bbbb' }],
      probeRuntimeInfo: async (serialPort: DeviceSerialPort) => runtimeByPath.get(serialPort.path),
      readConfiguredState: async () => ({
        'configured-1': {
          name: 'My Device',
          hostFolder: 'host/src',
          libraryFolders: ['lib'],
          syncExcludedPaths: ['tmp'],
          lastKnownSerialPortPath: '/dev/ttyUSB1'
        }
      })
    });

    await controller.initialise();
    const device = controller.getDevice('configured-1');
    assert.ok(device);
    assert.strictEqual(device?.name, 'My Device');
    assert.strictEqual(device?.hostFolder, 'host/src');
    assert.strictEqual(device?.lastKnownSerialPortPath, '/dev/ttyUSB2');
  });
});
