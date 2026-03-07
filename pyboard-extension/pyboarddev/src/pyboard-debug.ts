/**
 * Module overview:
 * Provides lightweight output-channel logging helpers for pyboard-related
 * debug output.
 */
import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel;
const autoRevealOutputChannelOnLog = false;

export const initOutputChannel = () => {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Mektrol PyDevice');
};

export const logChannelOutput = (content: string, show = true): void => {
  outputChannel.appendLine(content);
  if (show && autoRevealOutputChannelOnLog) {
    outputChannel.show(true);
  }
};
