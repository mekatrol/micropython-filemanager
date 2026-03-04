import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { Pyboard } from '../utils/pyboard';

const selectedSerialPortStateKey = 'selectedSerialPort';
const selectedBaudRateStateKey = 'selectedBaudRate';
const defaultBaudRate = 115200;

let connectedBoard: Pyboard | undefined;
const boardConnectionStateEmitter = new vscode.EventEmitter<boolean>();

export const onBoardConnectionStateChanged = boardConnectionStateEmitter.event;
export const isBoardConnected = (): boolean => connectedBoard !== undefined;
export const getConnectedBoard = (): Pyboard | undefined => connectedBoard;

const notifyBoardConnectionStateChanged = (): void => {
  boardConnectionStateEmitter.fire(isBoardConnected());
};

export const closeConnectedBoard = async (showSuccessMessage = true): Promise<void> => {
  if (!connectedBoard) {
    if (showSuccessMessage) {
      const msg = 'No active board connection to close.';
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    }
    return;
  }

  try {
    await connectedBoard.close();
    connectedBoard = undefined;
    notifyBoardConnectionStateChanged();

    if (showSuccessMessage) {
      const msg = 'Board connection closed.';
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    } else {
      logChannelOutput('Board connection closed during extension shutdown.', false);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const msg = `Failed to close board connection. ${reason}`;
    logChannelOutput(msg, true);
  }
};

export const initConnectBoardCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.connectboard', async () => {
    const device = context.workspaceState.get<string>(selectedSerialPortStateKey);
    const baudRate = context.workspaceState.get<number>(selectedBaudRateStateKey) ?? defaultBaudRate;

    if (!device) {
      const msg = 'No serial device selected. Select a serial port first.';
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    try {
      if (connectedBoard) {
        await closeConnectedBoard(false);
      }

      const board = new Pyboard(device, baudRate);
      await board.open();
      connectedBoard = board;
      notifyBoardConnectionStateChanged();

      const msg = `Connected to board on ${device} @ ${baudRate}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Failed to connect to board on ${device} @ ${baudRate}. ${reason}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
    }
  });

  context.subscriptions.push(command);
};

export const initDisconnectBoardCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.disconnectboard', async () => {
    await closeConnectedBoard(true);
  });

  context.subscriptions.push(command);
};

export const initToggleBoardConnectionCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.toggleboardconnection', async () => {
    if (isBoardConnected()) {
      await closeConnectedBoard(true);
      return;
    }

    await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard');
  });

  context.subscriptions.push(command);
};
