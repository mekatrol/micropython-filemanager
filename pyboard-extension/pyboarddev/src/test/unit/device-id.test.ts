/**
 * Unit tests for device-id helpers.
 *
 * These tests intentionally cover both valid and edge-case paths so that
 * identifier generation remains stable, deterministic, and safe for storage
 * keys, map keys, and display usage.
 */
import * as assert from 'assert';
import { normaliseDeviceId, toDeviceId } from '../../devices/device-id';

suite('device-id', () => {
  test('normaliseDeviceId trims and sanitises input', () => {
    // We provide an id that contains:
    // 1) leading/trailing whitespace,
    // 2) internal spaces,
    // 3) a slash character.
    // The function should produce a safe, compact id value.
    const rawInput = '  my board/01  ';

    // We execute the normalisation helper to convert the raw input into
    // a canonical identifier format.
    const normalised = normaliseDeviceId(rawInput);

    // Expected behavior:
    // - outer whitespace removed,
    // - spaces replaced with '-',
    // - unsupported characters replaced with '_'.
    assert.strictEqual(normalised, 'my-board_01');
  });

  test('normaliseDeviceId falls back for empty values', () => {
    // This input is intentionally only spaces.
    // That means there is no meaningful identifier content.
    const emptyLikeInput = '   ';

    // Execute the function under test.
    const normalised = normaliseDeviceId(emptyLikeInput);

    // Expected behavior for empty content is a stable fallback value.
    assert.strictEqual(normalised, 'unknown-device');
  });

  test('toDeviceId prefers runtime unique id when present', () => {
    // The runtime info includes a device unique id.
    // The helper should prioritise this over the serial port path so IDs remain
    // stable across port changes.
    const runtimeInfo = {
      runtimeName: 'MicroPython' as const,
      version: '1.22.0',
      machine: 'ESP32',
      uniqueId: ' chip 123 ',
      banner: 'MicroPython v1.22'
    };

    // Execute ID derivation with runtime info available.
    const id = toDeviceId('/dev/ttyUSB0', runtimeInfo);

    // Expected behavior: id derives from uniqueId (after normalisation),
    // not from '/dev/ttyUSB0'.
    assert.strictEqual(id, 'chip-123');
  });

  test('toDeviceId falls back to port path when runtime info is missing', () => {
    // We intentionally omit runtime info to simulate early connection stages
    // where UID probing has not succeeded yet.
    const runtimeInfo = undefined;

    // Execute ID derivation using only a serial path.
    const id = toDeviceId('/dev/ttyUSB0', runtimeInfo);

    // Expected behavior: fallback format starts with 'port_' and contains a
    // normalised representation of the path.
    assert.strictEqual(id, 'port__dev_ttyUSB0');
  });
});
