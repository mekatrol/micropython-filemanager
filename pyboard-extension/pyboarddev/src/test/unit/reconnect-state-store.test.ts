/**
 * Unit tests for reconnect-state persistence behavior.
 *
 * We verify default/failure paths as well as normal read/write flows so
 * reconnect behavior remains predictable across sessions.
 */
import * as assert from 'assert';
import { ReconnectStateStore } from '../../devices/reconnect-state-store';

suite('ReconnectStateStore', () => {
  const pathsKey = 'paths';

  test('reads default values for missing state', () => {
    // Arrange: provide read/write adapters where reads always return undefined.
    // This simulates a first-run scenario with no persisted data.
    const store = new ReconnectStateStore(
      () => undefined,
      async () => undefined,
      pathsKey
    );

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

});
