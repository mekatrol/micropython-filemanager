/**
 * Unit tests for reconnect-state persistence behavior.
 *
 * We verify default/failure paths as well as normal read/write flows so
 * reconnect behavior remains predictable across sessions.
 */
import * as assert from 'assert';
import { ReconnectStateStore } from '../../devices/reconnect-state-store';

suite('ReconnectStateStore', () => {
  // Shared keys used by the store under test.
  // Keeping them local to this suite makes expected state shape explicit.
  const reconnectKey = 'reconnect';
  const pathsKey = 'paths';

  test('reads default values for missing state', () => {
    // Arrange: provide read/write adapters where reads always return undefined.
    // This simulates a first-run scenario with no persisted data.
    const store = new ReconnectStateStore(
      () => undefined,
      async () => undefined,
      reconnectKey,
      pathsKey
    );

    // Act + Assert: missing reconnect flag should default to false.
    assert.strictEqual(store.readShouldReconnect(), false);

    // Act + Assert: missing device-path list should default to an empty array.
    assert.deepStrictEqual(store.readReconnectDevicePaths(), []);
  });

  test('normalises and deduplicates reconnect device paths', async () => {
    // Arrange: intentionally messy stored state includes duplicates,
    // whitespace, and a non-string value.
    const state: Record<string, unknown> = {
      [pathsKey]: [' /dev/ttyUSB0 ', '/dev/ttyUSB0', 42, '/dev/ttyUSB1']
    };

    // Arrange: create store with in-memory read/write adapters.
    const store = new ReconnectStateStore(
      <T>(key: string): T | undefined => state[key] as T | undefined,
      async (key, value) => { state[key] = value; },
      reconnectKey,
      pathsKey
    );

    // Act: read and normalise stored paths.
    const normalisedPaths = store.readReconnectDevicePaths();

    // Assert: values are trimmed, non-strings removed, and duplicates collapsed.
    assert.deepStrictEqual(normalisedPaths, ['/dev/ttyUSB0', '/dev/ttyUSB1']);

    // Act: add a new path.
    await store.addReconnectDevicePath('/dev/ttyUSB2');

    // Assert: new path is appended exactly once.
    assert.deepStrictEqual(state[pathsKey], ['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyUSB2']);

    // Act: remove an existing path.
    await store.removeReconnectDevicePath('/dev/ttyUSB0');

    // Assert: removed value is gone, other values remain.
    assert.deepStrictEqual(state[pathsKey], ['/dev/ttyUSB1', '/dev/ttyUSB2']);
  });

  test('writeShouldReconnect persists boolean state', async () => {
    // Arrange: start with empty in-memory state map.
    const state: Record<string, unknown> = {};

    // Arrange: use adapters that read/write that map.
    const store = new ReconnectStateStore(
      <T>(key: string): T | undefined => state[key] as T | undefined,
      async (key, value) => { state[key] = value; },
      reconnectKey,
      pathsKey
    );

    // Act: request reconnect persistence.
    await store.writeShouldReconnect(true);

    // Assert: expected key now contains true.
    assert.strictEqual(state[reconnectKey], true);
  });
});
