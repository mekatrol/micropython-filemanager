import * as assert from 'assert';
import { normaliseDeviceId, toDeviceId } from '../../devices/device-id';

suite('device-id', () => {
  test('normaliseDeviceId trims and sanitises input', () => {
    assert.strictEqual(normaliseDeviceId('  my board/01  '), 'my-board_01');
  });

  test('normaliseDeviceId falls back for empty values', () => {
    assert.strictEqual(normaliseDeviceId('   '), 'unknown-device');
  });

  test('toDeviceId prefers runtime unique id when present', () => {
    const id = toDeviceId('/dev/ttyUSB0', {
      runtimeName: 'MicroPython',
      version: '1.22.0',
      machine: 'ESP32',
      uniqueId: ' chip 123 ',
      banner: 'MicroPython v1.22'
    });
    assert.strictEqual(id, 'chip-123');
  });

  test('toDeviceId falls back to port path when runtime info is missing', () => {
    const id = toDeviceId('/dev/ttyUSB0');
    assert.strictEqual(id, 'port__dev_ttyUSB0');
  });
});
