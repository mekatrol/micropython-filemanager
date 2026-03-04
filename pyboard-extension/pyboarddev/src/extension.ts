import * as vscode from 'vscode';
import { initStatusBar } from './status-bar';
import { initOutputChannel, logChannelOutput as logChannelOutput } from './output-channel';
import { initCreateConfigCommand } from './commands/create-config-command';
import { initAutoDetectDevicesCommand } from './commands/auto-detect-devices-command';
import {
  closeConnectedBoard,
  initConnectBoardCommand,
  initDisconnectBoardCommand,
  initSetAutoReconnectCommand,
  initToggleBoardConnectionCommand,
  tryReconnectBoardOnStartup
} from './commands/connect-board-command';
import { initDeviceMirrorExplorer } from './device-mirror-explorer';
import { initPyboardDebug } from './pyboard-debug';
import { initTerminal } from './terminal';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export const activate = async (context: vscode.ExtensionContext) => {
  // Initialise output channel for logging
  initOutputChannel();
  logChannelOutput('Mekatrol Pyboard Dev activated...', false);

  // Create commands
  initCreateConfigCommand(context);
  initAutoDetectDevicesCommand(context);
  initConnectBoardCommand(context);
  initDisconnectBoardCommand(context);
  initSetAutoReconnectCommand(context);
  initToggleBoardConnectionCommand(context);
  await tryReconnectBoardOnStartup(context);

  // Init status bar
  await initStatusBar(context);

  // Init device mirror explorer
  await initDeviceMirrorExplorer(context);

  // Init Run/Debug integration
  initPyboardDebug(context);

  // Init REPL terminal
  initTerminal(context);
};

// This method is called when your extension is deactivated
export async function deactivate() {
  await closeConnectedBoard(false, true, false);
}
