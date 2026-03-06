import * as assert from 'assert';
import { ReconnectStateStore } from '../../devices/reconnect-state-store';

suite('ReconnectStateStore', () => {
  const reconnectKey = 'reconnect';
  const pathsKey = 'paths';

  test('reads default values for missing state', () => {
    const store = new ReconnectStateStore(
      () => undefined,
      async () => undefined,
      reconnectKey,
      pathsKey
    );

    assert.strictEqual(store.readShouldReconnect(), false);
    assert.deepStrictEqual(store.readReconnectDevicePaths(), []);
  });

  test('normalises and deduplicates reconnect device paths', async () => {
    const state: Record<string, unknown> = {
      [pathsKey]: [' /dev/ttyUSB0 ', '/dev/ttyUSB0', 42, '/dev/ttyUSB1']
    };

    const store = new ReconnectStateStore(
      <T>(key: string): T | undefined => state[key] as T | undefined,
      async (key, value) => { state[key] = value; },
      reconnectKey,
      pathsKey
    );

    assert.deepStrictEqual(store.readReconnectDevicePaths(), ['/dev/ttyUSB0', '/dev/ttyUSB1']);

    await store.addReconnectDevicePath('/dev/ttyUSB2');
    assert.deepStrictEqual(state[pathsKey], ['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyUSB2']);

    await store.removeReconnectDevicePath('/dev/ttyUSB0');
    assert.deepStrictEqual(state[pathsKey], ['/dev/ttyUSB1', '/dev/ttyUSB2']);
  });

  test('writeShouldReconnect persists boolean state', async () => {
    const state: Record<string, unknown> = {};
    const store = new ReconnectStateStore(
      <T>(key: string): T | undefined => state[key] as T | undefined,
      async (key, value) => { state[key] = value; },
      reconnectKey,
      pathsKey
    );

    await store.writeShouldReconnect(true);
    assert.strictEqual(state[reconnectKey], true);
  });
});
