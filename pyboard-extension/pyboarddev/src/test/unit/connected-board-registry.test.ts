/**
 * Unit tests for the in-memory connected board registry.
 *
 * The goal is to validate lifecycle behavior, execution counters, and snapshot
 * output ordering so command/UI layers can rely on deterministic state.
 */
import * as assert from 'assert';
import { ConnectedBoardRegistry, ConnectedBoardState } from '../../devices/connected-board-registry';

// Minimal board stub factory.
// We only provide properties that registry logic reads (`device`, `baudrate`).
const toBoardStub = (devicePath: string, baudRate: number) => ({
  device: devicePath,
  baudrate: baudRate
}) as unknown as ConnectedBoardState['board'];

suite('ConnectedBoardRegistry', () => {
  test('add/get/remove lifecycle works as expected', () => {
    // Arrange: create fresh registry and one board state.
    const registry = new ConnectedBoardRegistry();
    const state: ConnectedBoardState = {
      deviceId: 'dev-1',
      board: toBoardStub('/dev/ttyUSB0', 115200),
      runtimeInfo: undefined,
      executionCount: 0
    };

    // Act: add the board to registry.
    registry.add(state);

    // Assert: registry reports connected and returns the same state by both
    // id and port-path lookup methods.
    assert.strictEqual(registry.isConnected(), true);
    assert.strictEqual(registry.getByDeviceId('dev-1'), state);
    assert.strictEqual(registry.getByPortPath('/dev/ttyUSB0'), state);

    // Assert: convenience reverse lookup (port -> id) matches inserted data.
    assert.strictEqual(registry.getDeviceIdForPortPath('/dev/ttyUSB0'), 'dev-1');

    // Act: remove the board.
    const removed = registry.remove('dev-1');

    // Assert: remove returns the previous state, registry becomes empty,
    // and lookups no longer resolve.
    assert.strictEqual(removed, state);
    assert.strictEqual(registry.isConnected(), false);
    assert.strictEqual(registry.getByDeviceId('dev-1'), undefined);
  });

  test('execution counters do not go negative', () => {
    // Arrange: initialize registry with a single board.
    const registry = new ConnectedBoardRegistry();
    const state: ConnectedBoardState = {
      deviceId: 'dev-1',
      board: toBoardStub('/dev/ttyUSB0', 115200),
      runtimeInfo: undefined,
      executionCount: 0
    };
    registry.add(state);

    // Assert negative-path: beginning execution for a missing device fails.
    assert.strictEqual(registry.beginExecution('missing'), false);

    // Act: begin execution for valid device.
    assert.strictEqual(registry.beginExecution('dev-1'), true);

    // Assert: executing flag becomes true.
    assert.strictEqual(registry.isExecuting('dev-1'), true);

    // Act: end one execution.
    assert.strictEqual(registry.endExecution('dev-1'), true);

    // Assert: executing flag returns to false.
    assert.strictEqual(registry.isExecuting('dev-1'), false);

    // Act: end execution again (counter already zero).
    assert.strictEqual(registry.endExecution('dev-1'), true);

    // Assert: counter remains clamped at zero (not negative), so executing
    // must still be false.
    assert.strictEqual(registry.isExecuting('dev-1'), false);
  });

  test('snapshots are sorted and include runtime info changes', () => {
    // Arrange: add states out of order by id to verify sort behavior later.
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

    // Act: set runtime info for one device.
    const changed = registry.setRuntimeInfo('a', {
      runtimeName: 'MicroPython',
      version: '1.23.0',
      machine: 'ESP32',
      banner: 'MicroPython'
    });

    // Assert: update succeeds for existing device and fails for missing device.
    assert.strictEqual(changed, true);
    assert.strictEqual(registry.setRuntimeInfo('missing', undefined), false);

    // Act: collect snapshots.
    const snapshots = registry.getSnapshots();

    // Assert: snapshots are sorted by deviceId, and include updated runtime info.
    assert.deepStrictEqual(snapshots.map((item) => item.deviceId), ['a', 'b']);
    assert.strictEqual(snapshots[0].runtimeInfo?.machine, 'ESP32');
  });
});
