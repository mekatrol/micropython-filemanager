import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel;
const autoRevealOutputChannelOnLog = false;

export const initOutputChannel = () => {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Mektrol Pyboard Dev');
};

export const logChannelOutput = (content: string, show = true): void => {
  outputChannel.appendLine(content);
  if (show && autoRevealOutputChannelOnLog) {
    outputChannel.show(true);
  }
};
