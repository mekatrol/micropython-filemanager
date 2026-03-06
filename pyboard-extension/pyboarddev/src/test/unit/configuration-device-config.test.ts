import * as assert from 'assert';
import {
  DeviceConfiguration,
  getDeviceHostFolderMappings,
  getDeviceLibraryFolderMappings,
  getDeviceNames,
  getDeviceSyncExcludedPaths,
  PyboardDevConfiguration
} from '../../utils/configuration';

suite('configuration DeviceConfiguration', () => {
  test('normalises values and removes invalid paths', () => {
    const config = new DeviceConfiguration({
      hostFolder: '  host ',
      libraryFolders: [' lib\\a ', '/lib/b/', '', 'lib/a'],
      name: '  board ',
      syncExcludedPaths: [' /a ', 'b/', 'a']
    });

    assert.strictEqual(config.getHostFolder(), 'host');
    assert.deepStrictEqual(config.getLibraryFolders(), ['lib/a', 'lib/b']);
    assert.strictEqual(config.getName(), 'board');
    assert.deepStrictEqual(config.getSyncExcludedPaths(), ['a', 'b']);
  });

  test('supports adding and removing sync exclusions', () => {
    const config = new DeviceConfiguration();
    config.addSyncExcludedPath('/foo/');
    config.addSyncExcludedPath('foo');
    config.addSyncExcludedPath('bar');
    assert.deepStrictEqual(config.getSyncExcludedPaths(), ['bar', 'foo']);

    config.removeSyncExcludedPath('/bar/');
    assert.deepStrictEqual(config.getSyncExcludedPaths(), ['foo']);
  });

  test('fromUnknown ignores invalid payloads', () => {
    const emptyFromScalar = DeviceConfiguration.fromUnknown(42);
    assert.deepStrictEqual(emptyFromScalar.toJSON(), {});

    const fromObject = DeviceConfiguration.fromUnknown({
      hostFolder: 12,
      libraryFolders: ['a', 2],
      name: 'device',
      syncExcludedPaths: ['x', null]
    });

    assert.deepStrictEqual(fromObject.toJSON(), {
      libraryFolders: ['a'],
      name: 'device',
      syncExcludedPaths: ['x']
    });
  });

  test('mapping helpers include only populated values', () => {
    const full = new DeviceConfiguration({
      hostFolder: 'host-folder',
      libraryFolders: ['libs/common'],
      name: 'devname',
      syncExcludedPaths: ['tmp']
    });
    const empty = new DeviceConfiguration();
    const config: PyboardDevConfiguration = {
      mirrorFolder: '',
      devices: {
        a: full,
        b: empty
      }
    };

    assert.deepStrictEqual(getDeviceHostFolderMappings(config), { a: 'host-folder' });
    assert.deepStrictEqual(getDeviceLibraryFolderMappings(config), { a: ['libs/common'] });
    assert.deepStrictEqual(getDeviceNames(config), { a: 'devname' });
    assert.deepStrictEqual(getDeviceSyncExcludedPaths(config), { a: ['tmp'] });
  });
});
