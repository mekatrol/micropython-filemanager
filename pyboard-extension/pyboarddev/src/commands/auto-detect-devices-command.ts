/**
 * Module overview:
 * Implements serial auto-detection: scans ports, probes runtime info,
 * and starts a connection for the selected detected device.
 */
import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { listAllSerialPorts } from '../utils/serial-port';
import { getConnectedPyDeviceByPortPath } from './connect-board-command';
import { ProbedSerialDevice, SerialDeviceProber } from '../devices/serial-device-prober';
import { showErrorMessage, showWarningMessage, t } from '../utils/i18n';

const autoDetectDevicesCommandId = 'mekatrol.pydevice.autodetectdevices';
const defaultBaudRate = 115200;

type DetectedDevice = ProbedSerialDevice;

interface DetectedDevicePickItem extends vscode.QuickPickItem {
  device: DetectedDevice;
}

const buildDeviceDetails = (device: DetectedDevice): string => {
  const parts = [device.port.manufacturer, `VID:${device.port.vendorId}`, `PID:${device.port.productId}`].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : t('No USB metadata');
};

export const initAutoDetectDevicesCommand = (context: vscode.ExtensionContext): void => {
  const serialDeviceProber = new SerialDeviceProber(defaultBaudRate);
  const command = vscode.commands.registerCommand(autoDetectDevicesCommandId, async () => {
    let detectedDevices: DetectedDevice[] = [];
    try {
      detectedDevices = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('PyDevice: Detecting serial devices...'),
          cancellable: false
        },
        async (progress) => {
          const ports = await listAllSerialPorts();
          if (ports.length === 0) {
            return [];
          }

          const availablePorts = ports.filter((port) => !getConnectedPyDeviceByPortPath(port.path));
          if (availablePorts.length === 0) {
            return [];
          }

          const results: DetectedDevice[] = [];
          const increment = 100 / availablePorts.length;

          for (const port of availablePorts) {
            progress.report({ increment, message: `Probing ${port.path}` });
            const detected = await serialDeviceProber.probePort(port);
            if (detected.status === 'detected' && detected.runtimeInfo) {
              results.push(detected);
            }
          }

          return results;
        }
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Auto detect failed. ${reason}`;
      showErrorMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    if (detectedDevices.length === 0) {
      const msg = 'No accessible serial devices detected (connected ports are skipped).';
      showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    const items: DetectedDevicePickItem[] = detectedDevices.map((device) => ({
      label: device.port.path,
      description: device.runtimeInfo
        ? `${device.runtimeInfo.banner}${device.runtimeInfo.uniqueId ? ` | UID:${device.runtimeInfo.uniqueId}` : ''}`
        : t('Detected device'),
      detail: `${buildDeviceDetails(device)}${device.runtimeInfo?.uniqueId ? ` | Unique ID: ${device.runtimeInfo.uniqueId}` : ''}`,
      picked: false,
      device
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: t('Select a detected serial device to connect'),
      canPickMany: false,
      ignoreFocusOut: true
    });

    if (!selected) {
      return;
    }

    await vscode.commands.executeCommand('mekatrol.pydevice.connectboard', { devicePath: selected.device.port.path });
  });

  context.subscriptions.push(command);
};
