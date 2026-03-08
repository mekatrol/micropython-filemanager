/**
 * Module overview:
 * Provides a dedicated "PyDevice Logger" output channel for extension-wide logs.
 */
import * as vscode from 'vscode';
import { FileWatcherEvent } from './utils/file-watcher';
import { onPyDeviceLoggerEvent } from './pydevice-logger-events';

let loggerChannel: vscode.OutputChannel | undefined;
let loggerEventSubscription: vscode.Disposable | undefined;
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
  if (!loggerEventSubscription) {
    loggerEventSubscription = onPyDeviceLoggerEvent((event) => {
      const detailsText = event.details ? ` ${JSON.stringify(event.details)}` : '';
      logPyDeviceLogger(`[${event.level.toUpperCase()}][${event.source}] ${event.action}: ${event.message}${detailsText}`);
    });
  }
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
  loggerEventSubscription?.dispose();
  loggerEventSubscription = undefined;

  if (!loggerChannel) {
    return;
  }

  loggerChannel.dispose();
  loggerChannel = undefined;
};
