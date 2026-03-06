import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSyncStateMap, scanComputerMirrorEntries, toRelativePath } from '../../utils/device-filesystem';

suite('device-filesystem utils', () => {
  test('toRelativePath normalises separators and trims slashes', () => {
    assert.strictEqual(toRelativePath('\\foo\\bar\\'), 'foo/bar');
    assert.strictEqual(toRelativePath('/foo/bar/'), 'foo/bar');
    assert.strictEqual(toRelativePath('/'), '');
  });

  test('buildSyncStateMap marks positive and negative sync states', () => {
    const computerEntries = [
      { relativePath: 'same.py', isDirectory: false, sha1: 'abc', size: 3 },
      { relativePath: 'computer-only.py', isDirectory: false, sha1: 'aaa', size: 3 },
      { relativePath: 'size-match.bin', isDirectory: false, size: 10 }
    ];
    const deviceEntries = [
      { relativePath: 'same.py', isDirectory: false, sha1: 'abc', size: 3 },
      { relativePath: 'device-only.py', isDirectory: false, sha1: 'bbb', size: 3 },
      { relativePath: 'size-match.bin', isDirectory: false, size: 10 },
      { relativePath: 'out-of-sync.py', isDirectory: false, sha1: 'zzz', size: 5 }
    ];

    const status = buildSyncStateMap(computerEntries, deviceEntries);
    assert.strictEqual(status.get('same.py'), 'synced');
    assert.strictEqual(status.get('size-match.bin'), 'synced');
    assert.strictEqual(status.get('computer-only.py'), 'computer_only');
    assert.strictEqual(status.get('device-only.py'), 'device_only');
    assert.strictEqual(status.get('out-of-sync.py'), 'device_only');
  });

  test('scanComputerMirrorEntries returns file and directory metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pyboarddev-test-'));
    try {
      await fs.mkdir(path.join(root, 'pkg'));
      await fs.writeFile(path.join(root, 'main.py'), 'print("ok")');
      await fs.writeFile(path.join(root, 'pkg', 'mod.py'), 'x = 1');

      const entries = await scanComputerMirrorEntries(root);
      const paths = entries.map((entry) => entry.relativePath).sort();
      assert.deepStrictEqual(paths, ['', 'main.py', 'pkg', 'pkg/mod.py']);

      const main = entries.find((entry) => entry.relativePath === 'main.py');
      assert.strictEqual(main?.isDirectory, false);
      assert.strictEqual(typeof main?.sha1, 'string');
      assert.strictEqual((main?.sha1?.length ?? 0) > 0, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('scanComputerMirrorEntries safely handles invalid root', async () => {
    const entries = await scanComputerMirrorEntries('/dev/null/does-not-exist');
    assert.deepStrictEqual(entries, [{ relativePath: '', isDirectory: true }]);
  });
});
