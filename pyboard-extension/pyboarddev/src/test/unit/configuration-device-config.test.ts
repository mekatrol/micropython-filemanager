/**
 * Unit tests for configuration-domain utility behavior.
 *
 * The suite validates normalization, mutation behavior, parsing of unknown
 * input, and helper projections used by other modules.
 */
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
    // Arrange: build config with noisy spacing, slash variance, duplicates,
    // and empty values.
    const config = new DeviceConfiguration({
      hostFolder: '  host ',
      libraryFolders: [' lib\\a ', '/lib/b/', '', 'lib/a'],
      name: '  board ',
      syncExcludedPaths: [' /a ', 'b/', 'a']
    });

    // Assert: host folder is trimmed.
    assert.strictEqual(config.getHostFolder(), 'host');

    // Assert: library folders are normalized, deduplicated, sorted.
    assert.deepStrictEqual(config.getLibraryFolders(), ['lib/a', 'lib/b']);

    // Assert: device name is trimmed.
    assert.strictEqual(config.getName(), 'board');

    // Assert: exclusion paths normalized and deduplicated.
    assert.deepStrictEqual(config.getSyncExcludedPaths(), ['a', 'b']);
  });

  test('supports adding and removing sync exclusions', () => {
    // Arrange: start from empty configuration.
    const config = new DeviceConfiguration();

    // Act: add one value with slash noise, then duplicate, then second value.
    config.addSyncExcludedPath('/foo/');
    config.addSyncExcludedPath('foo');
    config.addSyncExcludedPath('bar');

    // Assert: duplicate is ignored, values are normalized and sorted.
    assert.deepStrictEqual(config.getSyncExcludedPaths(), ['bar', 'foo']);

    // Act: remove one value using slash-noisy representation.
    config.removeSyncExcludedPath('/bar/');

    // Assert: removed value is gone and unrelated value remains.
    assert.deepStrictEqual(config.getSyncExcludedPaths(), ['foo']);
  });

  test('fromUnknown ignores invalid payloads', () => {
    // Act: parse non-object input.
    const emptyFromScalar = DeviceConfiguration.fromUnknown(42);

    // Assert: invalid input becomes empty config JSON.
    assert.deepStrictEqual(emptyFromScalar.toJSON(), {});

    // Arrange: mixed-validity object with invalid hostFolder and non-string
    // entries in arrays.
    const fromObject = DeviceConfiguration.fromUnknown({
      hostFolder: 12,
      libraryFolders: ['a', 2],
      name: 'device',
      syncExcludedPaths: ['x', null]
    });

    // Assert: only valid values survive parsing.
    assert.deepStrictEqual(fromObject.toJSON(), {
      libraryFolders: ['a'],
      name: 'device',
      syncExcludedPaths: ['x']
    });
  });

  test('mapping helpers include only populated values', () => {
    // Arrange: one fully populated device config and one empty config.
    const full = new DeviceConfiguration({
      hostFolder: 'host-folder',
      libraryFolders: ['libs/common'],
      name: 'devname',
      syncExcludedPaths: ['tmp']
    });
    const empty = new DeviceConfiguration();

    // Arrange: compose full configuration payload.
    const config: PyboardDevConfiguration = {
      mirrorFolder: '',
      devices: {
        a: full,
        b: empty
      }
    };

    // Assert: each projection helper returns only populated device `a`.
    assert.deepStrictEqual(getDeviceHostFolderMappings(config), { a: 'host-folder' });
    assert.deepStrictEqual(getDeviceLibraryFolderMappings(config), { a: ['libs/common'] });
    assert.deepStrictEqual(getDeviceNames(config), { a: 'devname' });
    assert.deepStrictEqual(getDeviceSyncExcludedPaths(config), { a: ['tmp'] });
  });
});
