/**
 * Unit tests for status-bar runtime summary formatting.
 *
 * This logic is UI-adjacent but pure, so we test it directly to ensure status
 * text remains stable and human-readable for both normal and edge cases.
 */
import * as assert from 'assert';
import { formatBoardRuntimeSummary } from '../../status-bar';
import type { ConnectedBoardSnapshot } from '../../commands/connect-board-command';

suite('status-bar formatting', () => {
  test('returns undefined for no boards', () => {
    // Act: request summary for empty board list.
    const summary = formatBoardRuntimeSummary([]);

    // Assert: no boards should produce no summary object.
    assert.strictEqual(summary, undefined);
  });

  test('formats runtime and execution details', () => {
    // Arrange: include one board with runtime info/execution count and one
    // board still probing runtime info.
    const boards: ConnectedBoardSnapshot[] = [
      {
        deviceId: 'dev-1',
        devicePath: '/dev/ttyUSB0',
        baudRate: 115200,
        runtimeInfo: {
          runtimeName: 'MicroPython',
          version: '1.23.0',
          machine: 'ESP32',
          banner: 'MicroPython v1.23'
        },
        executionCount: 2
      },
      {
        deviceId: 'dev-2',
        devicePath: '/dev/ttyUSB1',
        baudRate: 115200,
        runtimeInfo: undefined,
        executionCount: 0
      }
    ];

    // Act: generate summary with high truncation limit to avoid shortening.
    const summary = formatBoardRuntimeSummary(boards, 200);

    // Assert: helper should return a value object.
    assert.ok(summary);

    // Assert: full summary string includes runtime and exec details.
    assert.strictEqual(
      summary?.summary,
      'dev-1 (MicroPython 1.23.0 exec:2) | dev-2 (probing)'
    );

    // Assert: short text should equal summary when below max length.
    assert.strictEqual(summary?.shortText, summary?.summary);
  });

  test('truncates short text when max length is exceeded', () => {
    // Arrange: long enough summary content to trigger truncation.
    const boards: ConnectedBoardSnapshot[] = [
      {
        deviceId: 'very-long-device-id',
        devicePath: '/dev/ttyUSB0',
        baudRate: 115200,
        runtimeInfo: undefined,
        executionCount: 0
      }
    ];

    // Act: force very small max length.
    const summary = formatBoardRuntimeSummary(boards, 10);

    // Assert: helper should still return structured output.
    assert.ok(summary);

    // Assert: short text obeys exact max length contract.
    assert.strictEqual(summary?.shortText.length, 10);

    // Assert: truncation indicator should be visible.
    assert.ok(summary?.shortText.endsWith('...'));
  });
});
