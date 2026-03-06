import * as assert from 'assert';
import { formatBoardRuntimeSummary } from '../../status-bar';
import type { ConnectedBoardSnapshot } from '../../commands/connect-board-command';

suite('status-bar formatting', () => {
  test('returns undefined for no boards', () => {
    assert.strictEqual(formatBoardRuntimeSummary([]), undefined);
  });

  test('formats runtime and execution details', () => {
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

    const summary = formatBoardRuntimeSummary(boards, 200);
    assert.ok(summary);
    assert.strictEqual(
      summary?.summary,
      'dev-1 (MicroPython 1.23.0 exec:2) | dev-2 (probing)'
    );
    assert.strictEqual(summary?.shortText, summary?.summary);
  });

  test('truncates short text when max length is exceeded', () => {
    const boards: ConnectedBoardSnapshot[] = [
      {
        deviceId: 'very-long-device-id',
        devicePath: '/dev/ttyUSB0',
        baudRate: 115200,
        runtimeInfo: undefined,
        executionCount: 0
      }
    ];

    const summary = formatBoardRuntimeSummary(boards, 10);
    assert.ok(summary);
    assert.strictEqual(summary?.shortText.length, 10);
    assert.ok(summary?.shortText.endsWith('...'));
  });
});
