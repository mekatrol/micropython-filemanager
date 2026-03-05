import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { listAllSerialPorts, PortInfo } from '../utils/serial-port';
import { BoardRuntimeInfo, Pyboard } from '../utils/pyboard';
import { isBoardConnected } from './connect-board-command';

const autoDetectDevicesCommandId = 'mekatrol.pyboarddev.autodetectdevices';
const selectedSerialPortStateKey = 'selectedSerialPort';
const selectedBaudRateStateKey = 'selectedBaudRate';
const defaultBaudRate = 115200;

interface DetectedDevice {
  port: PortInfo;
  runtimeInfo?: BoardRuntimeInfo;
}

interface DetectedDevicePickItem extends vscode.QuickPickItem {
  device: DetectedDevice;
}

const detectDevice = async (port: PortInfo): Promise<DetectedDevice | undefined> => {
  const board = new Pyboard(port.path, defaultBaudRate, false);
  try {
    await board.open();
  } catch {
    return undefined;
  }

  try {
    const runtimeInfo = await board.probeBoardRuntimeInfo();
    return { port, runtimeInfo };
  } catch {
    return undefined;
  } finally {
    try {
      await board.close();
    } catch {
      // Ignore close errors during probing.
    }
  }
};

const buildDeviceDetails = (device: DetectedDevice): string => {
  const parts = [device.port.manufacturer, `VID:${device.port.vendorId}`, `PID:${device.port.productId}`].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : 'No USB metadata';
};

const readPersistentState = <T>(context: vscode.ExtensionContext, key: string): T | undefined => {
  const fromGlobal = context.globalState.get<T>(key);
  if (fromGlobal !== undefined) {
    return fromGlobal;
  }

  return context.workspaceState.get<T>(key);
};

const writePersistentState = async <T>(context: vscode.ExtensionContext, key: string, value: T): Promise<void> => {
  await context.globalState.update(key, value);
  await context.workspaceState.update(key, value);
};

export const initAutoDetectDevicesCommand = (context: vscode.ExtensionContext): void => {
  const command = vscode.commands.registerCommand(autoDetectDevicesCommandId, async () => {
    if (isBoardConnected()) {
      const msg = 'Disconnect from the board before running auto detect.';
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    let detectedDevices: DetectedDevice[] = [];
    try {
      detectedDevices = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Pyboard Dev: Detecting serial devices...',
          cancellable: false
        },
        async (progress) => {
          const ports = await listAllSerialPorts();
          if (ports.length === 0) {
            return [];
          }

          const results: DetectedDevice[] = [];
          const increment = 100 / ports.length;

          for (const port of ports) {
            progress.report({ increment, message: `Probing ${port.path}` });
            const detected = await detectDevice(port);
            if (detected) {
              results.push(detected);
            }
          }

          return results;
        }
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Auto detect failed. ${reason}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    if (detectedDevices.length === 0) {
      const msg = 'No accessible serial devices detected.';
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    const activeDevice = readPersistentState<string>(context, selectedSerialPortStateKey);
    const items: DetectedDevicePickItem[] = detectedDevices.map((device) => ({
      label: device.port.path,
      description: device.runtimeInfo
        ? `${device.runtimeInfo.banner}${device.runtimeInfo.uniqueId ? ` | UID:${device.runtimeInfo.uniqueId}` : ''}`
        : 'MicroPython device',
      detail: `${buildDeviceDetails(device)}${device.runtimeInfo?.uniqueId ? ` | Unique ID: ${device.runtimeInfo.uniqueId}` : ''}`,
      picked: device.port.path === activeDevice,
      device
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a detected serial device to connect',
      canPickMany: false,
      ignoreFocusOut: true
    });

    if (!selected) {
      return;
    }

    if (isBoardConnected()) {
      const msg = 'Board connected while device list was open. Disconnect before connecting to another device.';
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    await writePersistentState(context, selectedSerialPortStateKey, selected.device.port.path);
    await writePersistentState(context, selectedBaudRateStateKey, defaultBaudRate);

    await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard');
  });

  context.subscriptions.push(command);
};
