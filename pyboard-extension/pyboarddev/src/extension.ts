import * as vscode from 'vscode';
import { initStatusBar } from './status-bar';
import { initOutputChannel, logChannelOutput as logChannelOutput } from './output-channel';
import { initCreateConfigCommand } from './commands/create-config-command';
import { initTerminal } from './terminal';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export const activate = async (context: vscode.ExtensionContext) => {
  // Initialise output channel for logging
  initOutputChannel();
  logChannelOutput('Mekatrol Pyboard Dev activated...', false);

  // Create commands
  initCreateConfigCommand(context);

  // Init status bar
  await initStatusBar(context);

  // Init REPL terminal
  initTerminal();
};

// This method is called when your extension is deactivated
export function deactivate() {}
