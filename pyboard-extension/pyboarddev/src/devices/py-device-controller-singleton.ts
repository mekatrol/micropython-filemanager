/**
 * Module overview:
 * This file is part of the Pydevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import { loadConfiguration } from '../utils/configuration';
import { listAllSerialPorts } from '../utils/serial-port';
import { PyDeviceState } from './device';
import { DeviceSerialPort } from './device-serial-port';
import { PyDeviceController } from './py-device-controller';

const defaultBaudRate = 115200;

let singleton: PyDeviceController | undefined;
let startupPromise: Promise<PyDeviceController> | undefined;

type ConfiguredState = Record<string, Omit<PyDeviceState, 'deviceId' | 'connectedSerialPortPath' | 'runtimeInfo'>>;

const readConfiguredState = async (): Promise<ConfiguredState> => {
  const configuration = await loadConfiguration();
  const configuredState: ConfiguredState = {};
  for (const [deviceId, deviceConfig] of Object.entries(configuration.devices ?? {})) {
    configuredState[deviceId] = {
      name: deviceConfig.getName(),
      hostFolder: deviceConfig.getHostFolder(),
      libraryFolders: deviceConfig.getLibraryFolders(),
      syncExcludedPaths: deviceConfig.getSyncExcludedPaths(),
      lastKnownSerialPortPath: undefined
    };
  }
  return configuredState;
};

const createController = (): PyDeviceController => {
  return new PyDeviceController({
    baudRate: defaultBaudRate,
    listPorts: listAllSerialPorts,
    probeRuntimeInfo: async (serialPort: DeviceSerialPort) => serialPort.probeRuntimeInfo(),
    readConfiguredState
  });
};

export const initialisePyDeviceController = async (): Promise<PyDeviceController> => {
  if (singleton) {
    return singleton;
  }
  if (startupPromise) {
    return startupPromise;
  }

  startupPromise = (async () => {
    const controller = createController();
    await controller.initialise();
    controller.startMonitoring();
    singleton = controller;
    return controller;
  })().finally(() => {
    startupPromise = undefined;
  });

  return startupPromise;
};

export const getPyDeviceController = (): PyDeviceController | undefined => {
  return singleton;
};

export const stopPyDeviceController = (): void => {
  startupPromise = undefined;
  if (!singleton) {
    return;
  }
  singleton.stopMonitoring();
  singleton = undefined;
};
