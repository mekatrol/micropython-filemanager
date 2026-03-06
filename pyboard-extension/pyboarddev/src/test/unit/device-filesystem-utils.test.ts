/**
 * Unit tests for filesystem utility behavior.
 *
 * These tests cover both happy-path and failure-path behavior for path
 * normalization, sync-state derivation, and local sync scanning.
 */
import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSyncStateMap, scanComputerSyncEntries, toRelativePath } from '../../utils/device-filesystem';

suite('device-filesystem utils', () => {
  test('toRelativePath normalises separators and trims slashes', () => {
    // Windows-style separators and trailing slash should collapse to posix form.
    assert.strictEqual(toRelativePath('\\foo\\bar\\'), 'foo/bar');

    // Leading and trailing slashes should be removed from posix paths.
    assert.strictEqual(toRelativePath('/foo/bar/'), 'foo/bar');

    // Root-only input should become an empty relative path.
    assert.strictEqual(toRelativePath('/'), '');
  });

  test('buildSyncStateMap marks positive and negative sync states', () => {
    // Arrange computer entries that include:
    // - one perfectly matching file,
    // - one computer-only file,
    // - one file without sha but with size metadata.
    const computerEntries = [
      { relativePath: 'same.py', isDirectory: false, sha1: 'abc', size: 3 },
      { relativePath: 'computer-only.py', isDirectory: false, sha1: 'aaa', size: 3 },
      { relativePath: 'size-match.bin', isDirectory: false, size: 10 }
    ];

    // Arrange device entries that include:
    // - matching file,
    // - device-only file,
    // - same-size file (no sha),
    // - file not found on computer (negative path).
    const deviceEntries = [
      { relativePath: 'same.py', isDirectory: false, sha1: 'abc', size: 3 },
      { relativePath: 'device-only.py', isDirectory: false, sha1: 'bbb', size: 3 },
      { relativePath: 'size-match.bin', isDirectory: false, size: 10 },
      { relativePath: 'out-of-sync.py', isDirectory: false, sha1: 'zzz', size: 5 }
    ];

    // Act: build sync-state lookup.
    const status = buildSyncStateMap(computerEntries, deviceEntries);

    // Assert: matching sha is synced.
    assert.strictEqual(status.get('same.py'), 'synced');

    // Assert: missing sha but equal file sizes is also treated as synced.
    assert.strictEqual(status.get('size-match.bin'), 'synced');

    // Assert: path present only on computer gets computer_only.
    assert.strictEqual(status.get('computer-only.py'), 'computer_only');

    // Assert: path present only on device gets device_only.
    assert.strictEqual(status.get('device-only.py'), 'device_only');

    // Assert: this path is also device-only because no matching computer entry exists.
    assert.strictEqual(status.get('out-of-sync.py'), 'device_only');
  });

  test('scanComputerSyncEntries returns file and directory metadata', async () => {
    // Arrange: create isolated temporary root to avoid touching workspace files.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pyboarddev-test-'));

    try {
      // Arrange: create directory and two files (one nested).
      await fs.mkdir(path.join(root, 'pkg'));
      await fs.writeFile(path.join(root, 'main.py'), 'print("ok")');
      await fs.writeFile(path.join(root, 'pkg', 'mod.py'), 'x = 1');

      // Act: scan sync entries from this root.
      const entries = await scanComputerSyncEntries(root);

      // Act: flatten and sort just the relative paths for deterministic assertion.
      const paths = entries.map((entry) => entry.relativePath).sort();

      // Assert: scanner always includes root '' and discovers created files/folder.
      assert.deepStrictEqual(paths, ['', 'main.py', 'pkg', 'pkg/mod.py']);

      // Act: retrieve metadata for one known file.
      const main = entries.find((entry) => entry.relativePath === 'main.py');

      // Assert: target is a file, has sha1 string, and sha length is non-zero.
      assert.strictEqual(main?.isDirectory, false);
      assert.strictEqual(typeof main?.sha1, 'string');
      assert.strictEqual((main?.sha1?.length ?? 0) > 0, true);
    } finally {
      // Cleanup: remove temporary root even when assertions fail.
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('scanComputerSyncEntries safely handles invalid root', async () => {
    // Act: scan an intentionally invalid root path.
    const entries = await scanComputerSyncEntries('/dev/null/does-not-exist');

    // Assert: function should not throw; it should return only the default root entry.
    assert.deepStrictEqual(entries, [{ relativePath: '', isDirectory: true }]);
  });
});

