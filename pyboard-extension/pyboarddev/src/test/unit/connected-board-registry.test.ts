import * as assert from 'assert';
import { ConnectedBoardRegistry, ConnectedBoardState } from '../../devices/connected-board-registry';

const toBoardStub = (devicePath: string, baudRate: number) => ({
  device: devicePath,
  baudrate: baudRate
}) as unknown as ConnectedBoardState['board'];

suite('ConnectedBoardRegistry', () => {
  test('add/get/remove lifecycle works as expected', () => {
    const registry = new ConnectedBoardRegistry();
    const state: ConnectedBoardState = {
      deviceId: 'dev-1',
      board: toBoardStub('/dev/ttyUSB0', 115200),
      runtimeInfo: undefined,
      executionCount: 0
    };

    registry.add(state);
    assert.strictEqual(registry.isConnected(), true);
    assert.strictEqual(registry.getByDeviceId('dev-1'), state);
    assert.strictEqual(registry.getByPortPath('/dev/ttyUSB0'), state);
    assert.strictEqual(registry.getDeviceIdForPortPath('/dev/ttyUSB0'), 'dev-1');

    const removed = registry.remove('dev-1');
    assert.strictEqual(removed, state);
    assert.strictEqual(registry.isConnected(), false);
    assert.strictEqual(registry.getByDeviceId('dev-1'), undefined);
  });

  test('execution counters do not go negative', () => {
    const registry = new ConnectedBoardRegistry();
    const state: ConnectedBoardState = {
      deviceId: 'dev-1',
      board: toBoardStub('/dev/ttyUSB0', 115200),
      runtimeInfo: undefined,
      executionCount: 0
    };
    registry.add(state);

    assert.strictEqual(registry.beginExecution('missing'), false);
    assert.strictEqual(registry.beginExecution('dev-1'), true);
    assert.strictEqual(registry.isExecuting('dev-1'), true);

    assert.strictEqual(registry.endExecution('dev-1'), true);
    assert.strictEqual(registry.isExecuting('dev-1'), false);

    assert.strictEqual(registry.endExecution('dev-1'), true);
    assert.strictEqual(registry.isExecuting('dev-1'), false);
  });

  test('snapshots are sorted and include runtime info changes', () => {
    const registry = new ConnectedBoardRegistry();
    registry.add({
      deviceId: 'b',
      board: toBoardStub('/dev/ttyUSB1', 9600),
      runtimeInfo: undefined,
      executionCount: 0
    });
    registry.add({
      deviceId: 'a',
      board: toBoardStub('/dev/ttyUSB0', 115200),
      runtimeInfo: undefined,
      executionCount: 0
    });

    const changed = registry.setRuntimeInfo('a', {
      runtimeName: 'MicroPython',
      version: '1.23.0',
      machine: 'ESP32',
      banner: 'MicroPython'
    });
    assert.strictEqual(changed, true);
    assert.strictEqual(registry.setRuntimeInfo('missing', undefined), false);

    const snapshots = registry.getSnapshots();
    assert.deepStrictEqual(snapshots.map((item) => item.deviceId), ['a', 'b']);
    assert.strictEqual(snapshots[0].runtimeInfo?.machine, 'ESP32');
  });
});
