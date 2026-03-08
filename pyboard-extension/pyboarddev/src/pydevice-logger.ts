/**
 * Module overview:
 * Provides a dedicated "PyDevice Logger" output channel for extension-wide logs.
 */
import * as vscode from 'vscode';
import { FileWatcherEvent } from './util/file-watcher';

let loggerChannel: vscode.OutputChannel | undefined;
const recentFileWatcherLogs = new Map<string, number>();
const duplicateLogWindowMs = 300;

const ensureLoggerChannel = (): vscode.OutputChannel => {
  if (!loggerChannel) {
    loggerChannel = vscode.window.createOutputChannel('PyDevice Logger');
  }

  return loggerChannel;
};

export const initPyDeviceLogger = (): void => {
  ensureLoggerChannel();
};

export const logPyDeviceLogger = (message: string): void => {
  const channel = ensureLoggerChannel();
  const timestamp = new Date().toISOString();
  channel.appendLine(`[${timestamp}] ${message}`);
};

export const logFileWatcherEventToPyDeviceLogger = (event: FileWatcherEvent): void => {
  const dedupeKey = `${event.scope}|${event.changeType}|${event.workspaceRelativePath}`;
  const now = Date.now();
  const previous = recentFileWatcherLogs.get(dedupeKey);
  recentFileWatcherLogs.set(dedupeKey, now);

  if (recentFileWatcherLogs.size > 2000) {
    for (const [key, timestamp] of recentFileWatcherLogs) {
      if (now - timestamp > duplicateLogWindowMs * 4) {
        recentFileWatcherLogs.delete(key);
      }
    }
  }

  if (previous !== undefined && now - previous <= duplicateLogWindowMs) {
    return;
  }

  logPyDeviceLogger(
    `[FileWatcher] ${event.scope} ${event.source} ${event.changeType} ${event.entityType}: ${event.workspaceRelativePath}`
  );
};

export const disposePyDeviceLogger = (): void => {
  if (!loggerChannel) {
    return;
  }

  loggerChannel.dispose();
  loggerChannel = undefined;
};
